// SPDX-License-Identifier: GPL-3.0-or-later
//
// C ABI shim exposing the hoshidicts C++ engine to JavaScript. Everything that
// crosses into wasm is a NUL-terminated JSON string owned by a function-local
// static, valid until the next call to the same function.

#include <algorithm>
#include <array>
#include <bit>
#include <cerrno>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <exception>
#include <filesystem>
#include <fstream>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

#ifdef HACHIDORI_OPFS
#include <fcntl.h>
#include <unistd.h>
#endif

#include <emscripten/emscripten.h>
#ifdef HACHIDORI_OPFS
#include <emscripten/wasmfs.h>
#endif
#include <glaze/glaze.hpp>
#include <hoshidicts.h>

// Not part of the engine's public headers; see the include path added for them
// in CMakeLists.txt. hdw_import needs a Yomitan archive's declared title before
// the importer turns it into a directory path, and the MDict header sniff to
// know when there is no such archive.
#include "mdict/mdict_reader.hpp"
#include "zip/zip.hpp"

// Not an anonymous namespace: glaze's field-name reflection takes the address of
// an `extern const T` sentinel, which requires T to have external linkage.
namespace hdw {

constexpr size_t MAX_LOOKUP_TEXT_BYTES = 4 * 1024;
constexpr size_t MAX_GLOSSARY_BYTES = 8 * 1024 * 1024;
constexpr size_t MAX_LOOKUP_RESPONSE_BYTES = 32 * 1024 * 1024;
constexpr size_t MAX_TRACE_STEPS = 32;
constexpr size_t MAX_MEDIA_DICTIONARY_BYTES = 1024;
constexpr size_t MAX_MEDIA_PATH_BYTES = 4 * 1024;
constexpr size_t MAX_MEDIA_BYTES = 4 * 1024 * 1024;

// Wire structs deliberately use the camelCase names from the extension's JSON
// contract so glaze's aggregate reflection emits them verbatim: no rename layer.
struct WireTrace {
  std::string name;
  std::string description;
};

struct WireGlossary {
  std::string dictionary;
  std::string glossary;
  std::string definitionTags;
  std::string termTags;
};

struct WireFrequency {
  int value = 0;
  std::string displayValue;
};

struct WireFrequencyEntry {
  std::string dictionary;
  std::vector<WireFrequency> frequencies;
};

struct WirePitch {
  int position = 0;
  std::string pattern;
  std::vector<int> nasal;
  std::vector<int> devoice;
};

struct WirePitchEntry {
  std::string dictionary;
  std::vector<WirePitch> pitches;
  std::vector<std::string> transcriptions;
};

struct WireTerm {
  std::string expression;
  std::string reading;
  std::string rules;
  // hoshidicts stores the score as a double since .hoshidicts_5 (a Yomitan
  // score is any JSON number); older layouts still hold an int32.
  double score = 0;
  std::vector<WireGlossary> glossaries;
  std::vector<WireFrequencyEntry> frequencies;
  std::vector<WirePitchEntry> pitches;
};

struct WireLookupResult {
  std::string matched;
  std::string deinflected;
  std::vector<WireTrace> trace;
  WireTerm term;
  int preprocessorSteps = 0;
};

struct WireLookupResponse {
  std::vector<WireLookupResult> results;
  size_t dictionaryCount = 0;
};

struct WireKanjiStat {
  std::string name;
  std::string value;
};

struct WireKanjiEntry {
  std::string dictionary;
  std::string onyomi;
  std::string kunyomi;
  std::string tags;
  std::vector<std::string> definitions;
  std::vector<WireKanjiStat> stats;
};

struct WireKanji {
  std::string character;
  std::vector<WireKanjiEntry> entries;
};

struct WireStyle {
  std::string dictionary;
  std::string styles;
};

struct WireImportReport {
  bool success = false;
  std::string title;
  uint64_t termCount = 0;
  uint64_t metaCount = 0;
  uint64_t frequencyCount = 0;
  uint64_t pitchCount = 0;
  uint64_t kanjiCount = 0;
  uint64_t mediaCount = 0;
  std::string error;
};

std::string g_last_error;
int g_storage_mode = -1;

void clear_error() { g_last_error.clear(); }

void set_error(std::string message) { g_last_error = std::move(message); }

// Anything thrown past here aborts the whole module and takes the extension's
// offscreen document with it, so every ABI entry point funnels through this.
std::string describe_current_exception() {
  try {
    throw;
  } catch (const std::exception& e) {
    return e.what();
  } catch (...) {
    return "unknown error";
  }
}

// The engine keeps raw references between its parts (Lookup borrows both the
// query and the deinflector), so the whole bundle lives or dies together and
// hdw_reset rebuilds it wholesale.
struct Engine {
  DictionaryQuery query;
  Deinflector deinflector;
  Lookup lookup{query, deinflector};
  size_t dictionary_count = 0;
  std::vector<std::string> term_paths;
};

std::optional<Engine>& engine_slot() {
  static std::optional<Engine> slot;
  return slot;
}

Engine& engine() {
  auto& slot = engine_slot();
  if (!slot.has_value()) {
    slot.emplace();
  }
  return *slot;
}

struct JsonWriteOptions : glz::opts {
  bool escape_control_characters = true;
};

template <typename T, auto Options = JsonWriteOptions{}>
std::string to_json(const T& value) {
  std::string out;
  if (auto ec = glz::write<Options>(value, out)) {
    throw std::runtime_error("json serialization failed: " + glz::format_error(ec, out));
  }
  return out;
}

void require_lookup_text_size(std::string_view value, std::string_view label) {
  if (value.size() > MAX_LOOKUP_TEXT_BYTES) {
    throw std::length_error(std::string{label} + " exceeds the 4096-byte lookup limit");
  }
}

struct LookupCopyBudget {
  size_t bytes = 0;
  bool needs_control_escaping = false;
};

bool contains_control_byte(std::string_view value) {
  // Detect any byte below 0x20 in eight-byte groups. memcpy permits unaligned
  // input; the high-bit mask excludes multibyte UTF-8. A borrow can mark a
  // neighbouring byte only when a control byte already exists in this word.
  while (value.size() >= sizeof(uint64_t)) {
    uint64_t word;
    std::memcpy(&word, value.data(), sizeof(word));
    if ((word - 0x2020202020202020ULL) & ~word & 0x8080808080808080ULL) return true;
    value.remove_prefix(sizeof(word));
  }
  return std::ranges::any_of(value, [](unsigned char byte) { return byte < 0x20; });
}

std::string copy_lookup_string(std::string_view value, LookupCopyBudget& budget,
                               std::string_view label,
                               size_t maximum = MAX_LOOKUP_RESPONSE_BYTES) {
  if (value.size() > maximum) {
    throw std::length_error(std::string{label} + " exceeds the permitted lookup size");
  }
  // Claim before allocating the wire copy. Serialized JSON has a separate
  // bound because quotes/control characters expand beyond these native bytes.
  if (value.size() > MAX_LOOKUP_RESPONSE_BYTES - budget.bytes) {
    throw std::length_error("native " + std::string{label} + " exceeds the aggregate response limit");
  }
  budget.bytes += value.size();
  // Glaze's full-control mode reserves six bytes per source byte, even for
  // ordinary text. Use its smaller fast path only after checking every copied
  // wire string; the default writer cannot preserve unescaped control bytes.
  if (!budget.needs_control_escaping) {
    budget.needs_control_escaping = contains_control_byte(value);
  }
  return std::string{value};
}

template <typename T>
std::string lookup_json(const T& value, const LookupCopyBudget& budget) {
  std::string out = budget.needs_control_escaping ? to_json(value) : to_json<T, glz::opts{}>(value);
  if (out.size() > MAX_LOOKUP_RESPONSE_BYTES) {
    throw std::length_error("serialized lookup response exceeds the 33554432-byte limit");
  }
  return out;
}

WireTerm convert_term(const TermResult& term, LookupCopyBudget& budget) {
  WireTerm out;
  out.expression = copy_lookup_string(term.expression, budget, "term expression");
  out.reading = copy_lookup_string(term.reading, budget, "term reading");
  out.rules = copy_lookup_string(term.rules, budget, "term rules");
  out.score = term.score;

  out.glossaries.reserve(term.glossaries.size());
  for (const auto& g : term.glossaries) {
    // glossary stays the raw Yomitan structured-content JSON string; the
    // renderer is the only thing that understands it.
    out.glossaries.emplace_back(
        copy_lookup_string(g.dict_name, budget, "glossary dictionary"),
        copy_lookup_string(g.glossary, budget, "glossary", MAX_GLOSSARY_BYTES),
        copy_lookup_string(g.definition_tags, budget, "definition tags"),
        copy_lookup_string(g.term_tags, budget, "term tags"));
  }

  out.frequencies.reserve(term.frequencies.size());
  for (const auto& f : term.frequencies) {
    WireFrequencyEntry entry;
    entry.dictionary = copy_lookup_string(f.dict_name, budget, "frequency dictionary");
    entry.frequencies.reserve(f.frequencies.size());
    for (const auto& v : f.frequencies) {
      entry.frequencies.emplace_back(v.value, copy_lookup_string(v.display_value, budget, "frequency display value"));
    }
    out.frequencies.push_back(std::move(entry));
  }

  out.pitches.reserve(term.pitches.size());
  for (const auto& p : term.pitches) {
    WirePitchEntry entry;
    entry.dictionary = copy_lookup_string(p.dict_name, budget, "pitch dictionary");
    entry.pitches.reserve(p.pitches.size());
    for (const auto& pitch : p.pitches) {
      entry.pitches.emplace_back(pitch.position, copy_lookup_string(pitch.pattern, budget, "pitch pattern"),
                                 pitch.nasal, pitch.devoice);
    }
    entry.transcriptions.reserve(p.transcriptions.size());
    for (const auto& transcription : p.transcriptions) {
      entry.transcriptions.push_back(copy_lookup_string(transcription, budget, "pitch transcription"));
    }
    out.pitches.push_back(std::move(entry));
  }

  return out;
}

WireLookupResult convert_result(const LookupResult& result, LookupCopyBudget& budget) {
  WireLookupResult out;
  out.matched = copy_lookup_string(result.matched, budget, "matched text");
  out.deinflected = copy_lookup_string(result.deinflected, budget, "deinflected text");
  if (result.trace.size() > MAX_TRACE_STEPS) {
    throw std::length_error("lookup trace exceeds the 32-step limit");
  }
  out.trace.reserve(result.trace.size());
  for (const auto& t : result.trace) {
    out.trace.emplace_back(copy_lookup_string(t.name, budget, "trace name"),
                           copy_lookup_string(t.description, budget, "trace description"));
  }
  out.term = convert_term(result.term, budget);
  out.preprocessorSteps = result.preprocessor_steps;
  return out;
}

std::vector<WireLookupResult> convert_results(const std::vector<LookupResult>& results, LookupCopyBudget& budget) {
  std::vector<WireLookupResult> out;
  out.reserve(results.size());
  for (const auto& result : results) {
    out.push_back(convert_result(result, budget));
  }
  return out;
}

struct WireOptions {
  std::string frequencyDictionary;
  std::string frequencyOrder;
  std::string primaryReading;
};

LookupFrequencyOrder parse_frequency_order(std::string_view name) {
  if (name == "ascending") {
    return LookupFrequencyOrder::Ascending;
  }
  if (name == "descending") {
    return LookupFrequencyOrder::Descending;
  }
  if (name == "disabled") {
    return LookupFrequencyOrder::Disabled;
  }
  return LookupFrequencyOrder::Auto;
}

// Upstream models "unset" as a nullopt, the wire format models it as "".
LookupOptions parse_options(const char* options_json) {
  LookupOptions options;
  if (options_json == nullptr || *options_json == '\0') {
    return options;
  }

  WireOptions wire;
  if (auto ec = glz::read<glz::opts{.error_on_unknown_keys = false}>(wire, std::string_view{options_json})) {
    throw std::runtime_error("invalid options json: " + glz::format_error(ec, std::string_view{options_json}));
  }

  require_lookup_text_size(wire.frequencyDictionary, "frequencyDictionary");
  require_lookup_text_size(wire.primaryReading, "primaryReading");
  if (!wire.frequencyDictionary.empty()) {
    options.frequency_dictionary = wire.frequencyDictionary;
  }
  if (!wire.primaryReading.empty()) {
    options.primary_reading = wire.primaryReading;
  }
  options.frequency_order = parse_frequency_order(wire.frequencyOrder);
  return options;
}

bool non_empty_file(const std::filesystem::path& path) {
  std::error_code error;
  if (!std::filesystem::is_regular_file(path, error)) {
    return false;
  }
  const auto size = std::filesystem::file_size(path, error);
  return !error && size > 0;
}

// Highest marker first, as query.cpp picks it, because the marker decides how the
// glossaries are encoded. 0 means the directory is not a dictionary at all.
int dictionary_version(const std::filesystem::path& dir) {
  for (const int version : {6, 5, 4, 3, 2, 1}) {
    if (std::filesystem::is_regular_file(dir / (".hoshidicts_" + std::to_string(version)))) {
      return version;
    }
  }
  return 0;
}

// The marker list must track the versions query.cpp still reads. dict.zstd
// belongs to exactly two of them: the importer writes .hoshidicts_4 (int32
// score) or .hoshidicts_6 (double score) only when it trained a zstd dictionary
// for the term banks, and then compresses every glossary against that
// dictionary, so a _4 or _6 directory missing it loads with an empty DDict and
// every glossary decompresses to "" -- add_dict cannot see that and reports
// success, which is worse than refusing the directory. _5, _3 and older never
// have one, which is also what every dictionary imported by an older engine
// looks like. A zero-length dict.zstd is exactly as unusable as a missing one,
// since ZSTD_createDDict() accepts an empty buffer without complaint.
struct WireIndexTitle {
  std::string title;
};

bool valid_hash_table(const std::filesystem::path &path) {
  std::error_code error;
  const uintmax_t size = std::filesystem::file_size(path, error);
  if (error || size < sizeof(uint32_t)) {
    return false;
  }
  uint32_t capacity = 0;
  std::ifstream input(path, std::ios::binary);
  input.read(reinterpret_cast<char *>(&capacity), sizeof(capacity));
  return input.good() && capacity >= 16 &&
         size == sizeof(uint32_t) + static_cast<uintmax_t>(capacity) * 16;
}

bool valid_bloom_filter(const std::filesystem::path &path) {
  std::error_code error;
  const uintmax_t size = std::filesystem::file_size(path, error);
  if (error || size < 2 * sizeof(uint64_t)) {
    return false;
  }
  uint64_t num_bits = 0;
  uint64_t num_hashes = 0;
  std::ifstream input(path, std::ios::binary);
  input.read(reinterpret_cast<char *>(&num_bits), sizeof(num_bits));
  input.read(reinterpret_cast<char *>(&num_hashes), sizeof(num_hashes));
  return input.good() && num_bits >= 64 && std::has_single_bit(num_bits) &&
         num_hashes > 0 && size == 2 * sizeof(uint64_t) + num_bits / 8;
}

bool valid_dictionary_index(const std::filesystem::path &path) {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    return false;
  }
  const std::string contents(std::istreambuf_iterator<char>(input), {});
  WireIndexTitle index;
  return !glz::read<glz::opts{.error_on_unknown_keys = false}>(
             index, std::string_view{contents}) &&
         !index.title.empty();
}

bool dictionary_files_present(const std::filesystem::path &dir) {
  const int version = dictionary_version(dir);
  if (version == 0) {
    return false;
  }
  if ((version == 4 || version == 6) && !non_empty_file(dir / "dict.zstd")) {
    return false;
  }
  return valid_dictionary_index(dir / "index.json") &&
         valid_hash_table(dir / "hash.table") &&
         valid_bloom_filter(dir / "bloom.filter") &&
         non_empty_file(dir / "blobs.bin");
}

// The loader maps every file into linear memory (Emscripten's mmap copies it
// in), and a refused memory.grow surfaces only as MAP_FAILED with errno ENOMEM
// (WasmFS syscalls.cpp _mmap_js; classic FS FS.ErrnoError(ENOMEM)). Callers zero
// errno before the add so that case reads differently from a damaged package.
std::string rejected_dictionary(const char* kind, const std::string& dict_path) {
  if (errno == ENOMEM) {
    return std::string{"not enough memory to load "} + kind + " dictionary: " + dict_path;
  }
  return std::string{kind} + " dictionary rejected: " + dict_path;
}

uint64_t meta_count(const SummaryMetaCount &counts, const std::string &mode) {
  auto it = counts.find(mode);
  return it == counts.end() ? 0 : it->second;
}

// dictionary_importer::import derives its output directory from the title
// inside the archive and remove_all()s that directory if anything later throws,
// so it must never be pointed straight at the directory holding the installed
// dictionaries: a title of ".." resolves to the parent of the output directory
// and takes everything under it with it, a title containing a separator lands
// somewhere nothing will ever load it from, and a re-import that fails partway
// truncates and then deletes the copy it was meant to replace. Everything below
// gives it a scratch directory instead and moves the finished dictionary into
// place afterwards.
constexpr std::string_view STAGING_DIR = ".hdw-import";
constexpr std::string_view REMOVAL_DIR = ".hdw-remove";
constexpr std::string_view STAGING_WORK = "new";
constexpr std::string_view STAGING_REPLACED = "replaced";
constexpr std::string_view BACKUP_READY = ".backup-ready";
constexpr std::string_view NEW_COMMITTED = ".new-committed";

struct RemoveOnExit {
  std::filesystem::path path;
  bool active = true;

  void release() { active = false; }

  ~RemoveOnExit() {
    if (!active) {
      return;
    }
    std::error_code error;
    std::filesystem::remove_all(path, error);
  }
};

// Internal staging directories cannot also be dictionary destinations.
bool usable_as_directory_name(std::string_view title) {
  return !title.empty() && title != "." && title != ".." &&
         title != STAGING_DIR && title != REMOVAL_DIR &&
         !title.contains('/') && !title.contains('\\') &&
         !title.contains('\0');
}

std::string unusable_title_error(std::string_view title) {
  if (title.empty()) {
    return "the archive declares no dictionary title";
  }
  return "the dictionary title \"" + std::string{title} +
         "\" cannot be used as a folder name";
}

// The importer decides the format from the file's first bytes (an MDict header
// or a ZIP), so the same sniff decides here whether there is an index.json to
// read at all.
bool looks_like_mdict(const std::string &path) {
  std::array<uint8_t, 64> head{};
  std::ifstream in(path, std::ios::binary);
  in.read(reinterpret_cast<char *>(head.data()), static_cast<std::streamsize>(head.size()));
  const auto read = static_cast<size_t>(std::max<std::streamsize>(0, in.gcount()));
  return mdict::looks_like_mdict(head.data(), read);
}

bool peek_title(const std::string &zip_path, std::string &title,
                std::string &error) {
  Zip zip;
  if (!zip.open(std::filesystem::path{zip_path})) {
    error = zip.error.empty() ? "failed to open zip" : zip.error;
    return false;
  }
  const int index_entry = zip.find("index.json");
  if (index_entry < 0) {
    error = "could not find index.json";
    return false;
  }
  const std::string index_json = zip.read(index_entry);
  WireIndexTitle index;
  if (glz::read<glz::opts{.error_on_unknown_keys = false}>(
          index, std::string_view{index_json})) {
    error = "could not parse index.json before import";
    return false;
  }
  title = std::move(index.title);
  return true;
}

void move_dictionary_files(const std::filesystem::path &source,
                           const std::filesystem::path &destination) {
  std::filesystem::create_directories(destination);
  std::vector<std::filesystem::path> files;
  for (const auto &entry : std::filesystem::directory_iterator(source)) {
    if (!entry.is_regular_file()) {
      throw std::runtime_error(
          "an imported dictionary contains an unsupported nested path");
    }
    files.push_back(entry.path());
  }
  std::ranges::sort(files, [](const auto &left, const auto &right) {
    const bool left_marker =
        left.filename().string().starts_with(".hoshidicts_");
    const bool right_marker =
        right.filename().string().starts_with(".hoshidicts_");
    if (left_marker != right_marker) {
      return !left_marker;
    }
    return left.filename() < right.filename();
  });
  for (const auto &file : files) {
    std::filesystem::rename(file, destination / file.filename());
  }
}

void flush_file(const std::filesystem::path &path) {
#ifdef HACHIDORI_OPFS
  const int fd = open(path.c_str(), O_RDWR);
  if (fd < 0) {
    throw std::system_error(errno, std::generic_category(),
                            "could not open " + path.string());
  }
  if (fsync(fd) != 0) {
    const int error = errno;
    close(fd);
    throw std::system_error(error, std::generic_category(),
                            "could not flush " + path.string());
  }
  close(fd);
#else
  static_cast<void>(path);
#endif
}

void flush_tree(const std::filesystem::path &root) {
  if (!std::filesystem::exists(root)) {
    return;
  }
  for (const auto &entry :
       std::filesystem::recursive_directory_iterator(root)) {
    if (entry.is_regular_file()) {
      flush_file(entry.path());
    }
  }
}

void write_marker(const std::filesystem::path &path,
                  std::string_view error_message) {
  std::ofstream marker(path, std::ios::binary | std::ios::trunc);
  if (!marker) {
    throw std::runtime_error(std::string{error_message});
  }
  marker.close();
  if (!marker) {
    throw std::runtime_error(std::string{error_message});
  }
  flush_file(path);
}

// OPFS does not support renaming directories. Move their flat file contents,
// writing the version marker last so an interrupted destination is never
// loaded. A previous import is kept under `aside` until the replacement is
// complete.
void install_dictionary(const std::filesystem::path &staged,
                        const std::filesystem::path &destination,
                        const std::filesystem::path &aside) {
  const bool replacing = std::filesystem::exists(destination);
  if (replacing) {
    std::filesystem::remove(destination / NEW_COMMITTED);
    std::filesystem::create_directories(aside.parent_path());
    try {
      move_dictionary_files(destination, aside);
      write_marker(aside / BACKUP_READY,
                   "could not commit the previous dictionary backup");
    } catch (...) {
      const auto backup_error = std::current_exception();
      try {
        std::filesystem::remove(aside / BACKUP_READY);
        move_dictionary_files(aside, destination);
      } catch (const std::exception &rollback_error) {
        throw std::runtime_error(std::string{"the previous dictionary could "
                                             "not be backed up or restored: "} +
                                 rollback_error.what());
      }
      std::rethrow_exception(backup_error);
    }
  }
  try {
    move_dictionary_files(staged, destination);
    flush_tree(destination);
    if (replacing) {
      write_marker(destination / NEW_COMMITTED,
                   "could not commit the replacement dictionary");
    }
  } catch (...) {
    const auto install_error = std::current_exception();
    try {
      std::filesystem::remove_all(destination);
      if (replacing) {
        std::filesystem::remove(aside / BACKUP_READY);
        move_dictionary_files(aside, destination);
      }
    } catch (const std::exception &rollback_error) {
      throw std::runtime_error(
          std::string{"installation failed and the previous dictionary could "
                      "not be restored: "} +
          rollback_error.what());
    }
    std::rethrow_exception(install_error);
  }
  if (replacing) {
    std::error_code cleanup_error;
    std::filesystem::remove_all(aside, cleanup_error);
    if (!cleanup_error) {
      std::filesystem::remove(destination / NEW_COMMITTED, cleanup_error);
    }
  }
}

bool directory_has_payload(const std::filesystem::path &directory) {
  for (const auto &entry : std::filesystem::directory_iterator(directory)) {
    const std::string name = entry.path().filename().string();
    if (name != BACKUP_READY && name != NEW_COMMITTED) {
      return true;
    }
  }
  return false;
}

void recover_interrupted_install(const std::filesystem::path &root) {
  const std::filesystem::path staging = root / STAGING_DIR;
  const std::filesystem::path work = staging / STAGING_WORK;
  const std::filesystem::path replaced = staging / STAGING_REPLACED;
  if (std::filesystem::is_directory(replaced)) {
    for (const auto &entry : std::filesystem::directory_iterator(replaced)) {
      if (!entry.is_directory()) {
        continue;
      }
      const std::filesystem::path destination = root / entry.path().filename();
      const std::filesystem::path ready = entry.path() / BACKUP_READY;
      const std::filesystem::path committed = destination / NEW_COMMITTED;
      if (std::filesystem::exists(committed)) {
        if (!dictionary_files_present(destination)) {
          if (!dictionary_files_present(entry.path())) {
            throw std::runtime_error("neither side of a committed dictionary "
                                     "replacement is loadable");
          }
          std::filesystem::remove_all(destination);
          std::filesystem::remove(ready);
          move_dictionary_files(entry.path(), destination);
        } else {
          std::filesystem::remove_all(entry.path());
          std::filesystem::remove(committed);
        }
        continue;
      }
      if (std::filesystem::exists(ready)) {
        if (!dictionary_files_present(entry.path())) {
          throw std::runtime_error(
              "the committed previous dictionary backup is not loadable");
        }
        std::filesystem::remove_all(destination);
        std::filesystem::remove(ready);
        move_dictionary_files(entry.path(), destination);
        continue;
      }
      if (!directory_has_payload(entry.path())) {
        std::filesystem::remove_all(entry.path());
        continue;
      }
      move_dictionary_files(entry.path(), destination);
    }
  }
  if (std::filesystem::is_directory(work)) {
    for (const auto &entry : std::filesystem::directory_iterator(work)) {
      if (!entry.is_directory()) {
        continue;
      }
      const std::filesystem::path destination = root / entry.path().filename();
      if (!dictionary_files_present(destination)) {
        std::filesystem::remove_all(destination);
      }
    }
  }
  if (std::filesystem::is_directory(root)) {
    for (const auto &entry : std::filesystem::directory_iterator(root)) {
      if (entry.is_directory() && entry.path().filename() != STAGING_DIR &&
          dictionary_files_present(entry.path())) {
        std::filesystem::remove(entry.path() / NEW_COMMITTED);
      }
    }
  }
  std::filesystem::remove_all(staging);
}

WireImportReport report_for(const ImportResult& result) {
  WireImportReport report;
  const auto& counts = result.summary.counts;
  report.success = result.success;
  report.title = result.title;
  report.termCount = counts.terms.total;
  report.metaCount = meta_count(counts.termMeta, "total");
  report.frequencyCount = meta_count(counts.termMeta, "freq");
  report.pitchCount = meta_count(counts.termMeta, "pitch") + meta_count(counts.termMeta, "ipa");
  report.kanjiCount = counts.kanji.total;
  report.mediaCount = counts.media.total;
  report.error = result.error;
  return report;
}

WireImportReport staged_import(const std::string& zip_path, const std::string& out_dir, bool low_ram) {
  WireImportReport report;
  const std::filesystem::path root{out_dir};
  if (root.empty()) {
    report.error = "no output directory";
    return report;
  }

  const std::filesystem::path staging = root / STAGING_DIR;
  const std::filesystem::path work = staging / STAGING_WORK;
  // A Yomitan archive's title is whatever index.json says, so it is checked
  // before the importer can turn it into a path. An MDict title comes from
  // MdictSource::sanitize_title, which yields one plain path component (no
  // separators, NUL, "." or ".."), so the importer cannot leave `work`; the
  // post-import usable_as_directory_name check below still applies to it.
  if (!looks_like_mdict(zip_path)) {
    std::string title;
    if (!peek_title(zip_path, title, report.error)) {
      return report;
    }
    const std::filesystem::path staged = (work / title).lexically_normal();
    if (!usable_as_directory_name(title) || staged.parent_path() != work.lexically_normal()) {
      report.title = title;
      report.error = unusable_title_error(title);
      return report;
    }
  }
  try {
    recover_interrupted_install(root);
    std::filesystem::create_directories(work);
  } catch (const std::exception& e) {
    report.error = std::string{"could not recover an interrupted dictionary installation: "} + e.what();
    return report;
  }
  RemoveOnExit cleanup{staging};

  report = report_for(dictionary_importer::import(zip_path, work.string(), low_ram));
  if (!report.success) {
    return report;
  }
  if (!usable_as_directory_name(report.title)) {
    report.success = false;
    report.error = unusable_title_error(report.title);
    return report;
  }
  const std::filesystem::path imported = work / report.title;
  if (!dictionary_files_present(imported)) {
    report.success = false;
    report.error = "the import produced no loadable dictionary";
    return report;
  }
  try {
    flush_tree(imported);
    install_dictionary(imported, root / report.title, staging / STAGING_REPLACED / report.title);
  } catch (const std::exception& e) {
    cleanup.release();
    report.success = false;
    report.error = std::string{"could not install the imported dictionary: "} + e.what();
  }
  return report;
}

std::vector<uint8_t> g_media;

}  // namespace hdw

using namespace hdw;

extern "C" {

EMSCRIPTEN_KEEPALIVE int hdw_init_storage(int persistent) {
  clear_error();
  const int requested_mode = persistent == 0 ? 0 : 1;
  if (g_storage_mode >= 0) {
    if (g_storage_mode == requested_mode) {
      return 1;
    }
    set_error("storage is already initialized with a different backend");
    return 0;
  }

  try {
    if (requested_mode == 0) {
      std::filesystem::create_directory("/dicts");
    } else {
#ifdef HACHIDORI_OPFS
      const backend_t backend = wasmfs_create_opfs_backend();
      if (wasmfs_create_directory("/dicts", 0777, backend) != 0) {
        throw std::runtime_error("could not mount OPFS at /dicts");
      }
#else
      throw std::runtime_error("this build has no OPFS backend");
#endif
    }
    recover_interrupted_install("/dicts");
    g_storage_mode = requested_mode;
    return 1;
  } catch (...) {
    set_error(describe_current_exception());
    return 0;
  }
}

EMSCRIPTEN_KEEPALIVE const char* hdw_last_error(void) { return g_last_error.c_str(); }

EMSCRIPTEN_KEEPALIVE const char* hdw_import(const char* zip_path, const char* out_dir, int low_ram) {
  static std::string out;
  clear_error();

  WireImportReport report;
  try {
    report = staged_import(zip_path == nullptr ? "" : zip_path, out_dir == nullptr ? "" : out_dir, low_ram != 0);
    if (!report.success && report.error.empty()) {
      report.error = "import failed";
    }
    if (!report.error.empty()) {
      set_error(report.error);
    }
  } catch (...) {
    report = WireImportReport{};
    report.error = describe_current_exception();
    set_error(report.error);
  }

  try {
    out = to_json(report);
  } catch (...) {
    set_error(describe_current_exception());
    out = R"({"success":false,"title":"","termCount":0,"metaCount":0,"frequencyCount":0,)"
          R"("pitchCount":0,"kanjiCount":0,"mediaCount":0,"error":"report serialization failed"})";
  }
  return out.c_str();
}

EMSCRIPTEN_KEEPALIVE void hdw_reset(void) {
  clear_error();
  try {
    engine_slot().reset();
    engine_slot().emplace();
  } catch (...) {
    set_error(describe_current_exception());
  }
}

EMSCRIPTEN_KEEPALIVE int hdw_add_dict(const char* path, int kind) {
  clear_error();
  if (path == nullptr || *path == '\0') {
    set_error("empty dictionary path");
    return 0;
  }
  try {
    auto& e = engine();
    const std::string dict_path{path};
    if (kind < 0 || kind > 3) {
      set_error("unknown dictionary kind " + std::to_string(kind));
      return 0;
    }
    if (!dictionary_files_present(std::filesystem::path{dict_path})) {
      set_error("not an imported dictionary directory: " + dict_path);
      return 0;
    }
    errno = 0;
    switch (kind) {
      case 0:
        if (!e.query.add_term_dict(dict_path)) {
          set_error(rejected_dictionary("term", dict_path));
          return 0;
        }
        e.term_paths.push_back(dict_path);
        break;
      case 1:
        if (!e.query.add_freq_dict(dict_path)) {
          set_error(rejected_dictionary("frequency", dict_path));
          return 0;
        }
        break;
      case 2:
        if (!e.query.add_pitch_dict(dict_path)) {
          set_error(rejected_dictionary("pitch", dict_path));
          return 0;
        }
        break;
      default:
        if (!e.query.add_kanji_dict(dict_path)) {
          set_error(rejected_dictionary("kanji", dict_path));
          return 0;
        }
        break;
    }
    e.dictionary_count += 1;
    return 1;
  } catch (...) {
    set_error(describe_current_exception());
    return 0;
  }
}

// Drops one package from the loaded set without rebuilding it. Returns the
// number of kinds removed; 0 with no error when the path was not loaded.
EMSCRIPTEN_KEEPALIVE int hdw_remove_dict(const char* path) {
  clear_error();
  if (path == nullptr || *path == '\0') {
    set_error("empty dictionary path");
    return 0;
  }
  try {
    auto& e = engine();
    const std::string dict_path{path};
    const size_t removed = e.query.remove_dict(dict_path);
    e.dictionary_count -= std::min(removed, e.dictionary_count);
    std::erase(e.term_paths, dict_path);
    g_media.clear();
    return static_cast<int>(removed);
  } catch (...) {
    set_error(describe_current_exception());
    return 0;
  }
}

// Reorders the loaded set to follow the JSON array of package paths in
// `order_json`. Returns 1 on success and 0, changing nothing, when the list is
// malformed or names a package that is not loaded.
EMSCRIPTEN_KEEPALIVE int hdw_set_dict_order(const char* order_json) {
  clear_error();
  try {
    std::vector<std::string> order;
    if (order_json == nullptr
        || glz::read<glz::opts{.error_on_unknown_keys = false}>(order, std::string_view{order_json})) {
      set_error("malformed dictionary order");
      return 0;
    }
    if (!engine().query.set_dict_order(order)) {
      set_error("dictionary order names a package that is not loaded");
      return 0;
    }
    return 1;
  } catch (...) {
    set_error(describe_current_exception());
    return 0;
  }
}

EMSCRIPTEN_KEEPALIVE const char* hdw_lookup(const char* text, int max_results, int scan_length,
                                            const char* options_json) {
  static std::string out;
  clear_error();

  try {
    auto& e = engine();
    WireLookupResponse response;
    response.dictionaryCount = e.dictionary_count;
    LookupCopyBudget budget;

    const std::string_view query_text{text == nullptr ? "" : text};
    if (!query_text.empty() && max_results > 0 && scan_length > 0) {
      require_lookup_text_size(query_text, "lookup text");
      const LookupOptions options = parse_options(options_json);
      // Four-argument overload: the sort preferences have to apply before the
      // max_results cap, otherwise ranking is decided by an arbitrary prefix.
      const auto results =
          e.lookup.lookup(std::string{query_text}, max_results, scan_length, options);
      response.results = convert_results(results, budget);
    }
    out = lookup_json(response, budget);
  } catch (...) {
    set_error(describe_current_exception());
    out = R"({"results":[],"dictionaryCount":0})";
  }
  return out.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* hdw_lookup_dictionary(const char* text, const char* dictionary_path,
                                                       int max_results, size_t scan_length,
                                                       const char* options_json) {
  static std::string out;
  clear_error();

  try {
    auto& e = engine();
    WireLookupResponse response;
    response.dictionaryCount = e.dictionary_count;
    LookupCopyBudget budget;

    const std::string_view query_text{text == nullptr ? "" : text};
    const std::string selected_path{dictionary_path == nullptr ? "" : dictionary_path};
    if (!query_text.empty() && max_results > 0 && scan_length > 0 &&
        std::ranges::find(e.term_paths, selected_path) != e.term_paths.end()) {
      require_lookup_text_size(query_text, "lookup text");
      const LookupOptions options = parse_options(options_json);
      const auto results = e.lookup.lookup_dictionary(
          std::string{query_text}, selected_path, max_results, scan_length, options);
      response.results = convert_results(results, budget);
    }
    out = lookup_json(response, budget);
  } catch (...) {
    set_error(describe_current_exception());
    out = R"({"results":[],"dictionaryCount":0})";
  }
  return out.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* hdw_kanji(const char* character) {
  static std::string out;
  clear_error();

  try {
    WireKanji wire;
    LookupCopyBudget budget;
    const std::string_view kanji{character == nullptr ? "" : character};
    if (!kanji.empty()) {
      require_lookup_text_size(kanji, "kanji text");
      KanjiResult result = engine().query.query_kanji(std::string{kanji});
      wire.entries.reserve(result.entries.size());
      for (const auto& entry : result.entries) {
        WireKanjiEntry out_entry;
        out_entry.dictionary = copy_lookup_string(entry.dict_name, budget, "kanji dictionary");
        out_entry.onyomi = copy_lookup_string(entry.onyomi, budget, "kanji onyomi");
        out_entry.kunyomi = copy_lookup_string(entry.kunyomi, budget, "kanji kunyomi");
        out_entry.tags = copy_lookup_string(entry.tags, budget, "kanji tags");
        out_entry.definitions.reserve(entry.definitions.size());
        for (const auto& definition : entry.definitions) {
          out_entry.definitions.push_back(copy_lookup_string(definition, budget, "kanji definition"));
        }
        out_entry.stats.reserve(entry.stats.size());
        for (const auto& [name, value] : entry.stats) {
          out_entry.stats.emplace_back(copy_lookup_string(name, budget, "kanji stat name"),
                                       copy_lookup_string(value, budget, "kanji stat value"));
        }
        // stats arrive from an unordered_map; sort so the rendered order is stable.
        std::ranges::sort(out_entry.stats, {}, &WireKanjiStat::name);
        wire.entries.push_back(std::move(out_entry));
      }
      // Empty character is the contract's "nothing matched" sentinel.
      if (!wire.entries.empty()) {
        wire.character = copy_lookup_string(result.character, budget, "kanji character");
      }
    }
    out = lookup_json(wire, budget);
  } catch (...) {
    set_error(describe_current_exception());
    out = R"({"character":"","entries":[]})";
  }
  return out.c_str();
}

EMSCRIPTEN_KEEPALIVE const char* hdw_styles(void) {
  static std::string out;
  clear_error();

  try {
    const auto styles = engine().query.get_styles();
    std::vector<WireStyle> wire;
    wire.reserve(styles.size());
    for (const auto& s : styles) {
      wire.push_back({s.dict_name, s.styles});
    }
    out = to_json(wire);
  } catch (...) {
    set_error(describe_current_exception());
    out = "[]";
  }
  return out.c_str();
}

EMSCRIPTEN_KEEPALIVE int hdw_media(const char* dictionary, const char* path) {
  clear_error();
  g_media.clear();
  if (dictionary == nullptr || path == nullptr) {
    set_error("missing dictionary or path");
    return 0;
  }
  try {
    // Copied out of the mmap'd dictionary so the pointer handed to JS survives a
    // later hdw_reset.
    if (std::string_view{dictionary}.size() > MAX_MEDIA_DICTIONARY_BYTES) {
      throw std::length_error("media dictionary exceeds the 1024-byte limit");
    }
    if (std::string_view{path}.size() > MAX_MEDIA_PATH_BYTES) {
      throw std::length_error("media path exceeds the 4096-byte limit");
    }
    const MediaFileView view = engine().query.get_media_file_view(dictionary, path);
    if (view.data == nullptr || view.size == 0) {
      return 0;
    }
    if (view.size > MAX_MEDIA_BYTES) {
      throw std::length_error("media exceeds the 4 MiB byte limit");
    }
    const auto* bytes = reinterpret_cast<const uint8_t*>(view.data);
    g_media.assign(bytes, bytes + view.size);
    return static_cast<int>(g_media.size());
  } catch (...) {
    set_error(describe_current_exception());
    g_media.clear();
    return 0;
  }
}

EMSCRIPTEN_KEEPALIVE const uint8_t* hdw_media_data(void) { return g_media.data(); }

}  // extern "C"
