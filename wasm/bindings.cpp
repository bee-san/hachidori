// SPDX-License-Identifier: GPL-3.0-or-later
//
// C ABI shim exposing the hoshidicts C++ engine to JavaScript. Everything that
// crosses into wasm is a NUL-terminated JSON string owned by a function-local
// static, valid until the next call to the same function.

#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <exception>
#include <filesystem>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include <emscripten/emscripten.h>
#include <glaze/glaze.hpp>
#include <hoshidicts.h>

// Not part of the engine's public headers; see the include path added for it in
// CMakeLists.txt. hdw_import needs the archive's declared title before the
// importer turns it into a directory path.
#include "zip/zip.hpp"

// Not an anonymous namespace: glaze's field-name reflection takes the address of
// an `extern const T` sentinel, which requires T to have external linkage.
namespace hdw {

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
  int score = 0;
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

template <typename T>
std::string to_json(const T& value) {
  std::string out;
  if (auto ec = glz::write_json(value, out)) {
    throw std::runtime_error("json serialization failed: " + glz::format_error(ec, out));
  }
  return out;
}

WireTerm convert_term(const TermResult& term) {
  WireTerm out;
  out.expression = term.expression;
  out.reading = term.reading;
  out.rules = term.rules;
  out.score = term.score;

  out.glossaries.reserve(term.glossaries.size());
  for (const auto& g : term.glossaries) {
    // glossary stays the raw Yomitan structured-content JSON string; the
    // renderer is the only thing that understands it.
    out.glossaries.push_back({g.dict_name, g.glossary, g.definition_tags, g.term_tags});
  }

  out.frequencies.reserve(term.frequencies.size());
  for (const auto& f : term.frequencies) {
    WireFrequencyEntry entry;
    entry.dictionary = f.dict_name;
    entry.frequencies.reserve(f.frequencies.size());
    for (const auto& v : f.frequencies) {
      entry.frequencies.push_back({v.value, v.display_value});
    }
    out.frequencies.push_back(std::move(entry));
  }

  out.pitches.reserve(term.pitches.size());
  for (const auto& p : term.pitches) {
    WirePitchEntry entry;
    entry.dictionary = p.dict_name;
    entry.pitches.reserve(p.pitches.size());
    for (const auto& pitch : p.pitches) {
      entry.pitches.push_back({pitch.position, pitch.pattern, pitch.nasal, pitch.devoice});
    }
    entry.transcriptions = p.transcriptions;
    out.pitches.push_back(std::move(entry));
  }

  return out;
}

WireLookupResult convert_result(const LookupResult& result) {
  WireLookupResult out;
  out.matched = result.matched;
  out.deinflected = result.deinflected;
  out.trace.reserve(result.trace.size());
  for (const auto& t : result.trace) {
    out.trace.push_back({t.name, t.description});
  }
  out.term = convert_term(result.term);
  out.preprocessorSteps = result.preprocessor_steps;
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
  for (const int version : {4, 3, 2, 1}) {
    if (std::filesystem::is_regular_file(dir / (".hoshidicts_" + std::to_string(version)))) {
      return version;
    }
  }
  return 0;
}

// DictionaryQuery::add_dict signals every failure by silently returning, and the
// per-kind dictionary vectors are private, so hdw_add_dict cannot observe the
// outcome directly. Checking the on-disk layout up front catches the case that
// actually happens -- a missing or half-written /dicts entry -- but not a corrupt
// hash table or an unparseable index.json.
//
// The marker list must track the versions query.cpp still reads. dict.zstd
// belongs to exactly one of them: the importer writes .hoshidicts_4 only when it
// trained a zstd dictionary for the term banks, and then compresses every
// glossary against that dictionary, so a _4 directory missing it loads with an
// empty DDict and every glossary decompresses to "" -- add_dict cannot see that
// and reports success, which is worse than refusing the directory. _3 and older
// never have one, which is also what every dictionary imported by an older engine
// looks like. A zero-length dict.zstd is exactly as unusable as a missing one,
// since ZSTD_createDDict() accepts an empty buffer without complaint.
bool dictionary_files_present(const std::filesystem::path& dir) {
  const int version = dictionary_version(dir);
  if (version == 0) {
    return false;
  }
  if (version >= 4 && !non_empty_file(dir / "dict.zstd")) {
    return false;
  }
  return std::filesystem::is_regular_file(dir / "index.json") &&
         std::filesystem::is_regular_file(dir / "hash.table") &&
         std::filesystem::is_regular_file(dir / "bloom.filter") &&
         std::filesystem::is_regular_file(dir / "blobs.bin");
}

uint64_t meta_count(const SummaryMetaCount& counts, const std::string& mode) {
  auto it = counts.find(mode);
  return it == counts.end() ? 0 : it->second;
}

// dictionary_importer::import derives its output directory from the title inside
// the archive and remove_all()s that directory if anything later throws, so it
// must never be pointed straight at the directory holding the installed
// dictionaries: a title of ".." resolves to the parent of the output directory
// and takes everything under it with it, a title containing a separator lands
// somewhere nothing will ever load it from, and a re-import that fails partway
// truncates and then deletes the copy it was meant to replace. Everything below
// gives it a scratch directory instead and moves the finished dictionary into
// place afterwards.
constexpr std::string_view STAGING_DIR = ".hdw-import";
constexpr std::string_view STAGING_WORK = "new";
constexpr std::string_view STAGING_REPLACED = "replaced";

struct RemoveOnExit {
  std::filesystem::path path;

  ~RemoveOnExit() {
    std::error_code error;
    std::filesystem::remove_all(path, error);
  }
};

// STAGING_DIR is excluded because the import is assembled inside it: a title
// naming it would make the staging root its own destination.
bool usable_as_directory_name(std::string_view title) {
  return !title.empty() && title != "." && title != ".." && title != STAGING_DIR &&
         title.find('/') == std::string_view::npos && title.find('\\') == std::string_view::npos;
}

std::string unusable_title_error(std::string_view title) {
  if (title.empty()) {
    return "the archive declares no dictionary title";
  }
  return "the dictionary title \"" + std::string{title} + "\" cannot be used as a folder name";
}

struct WireIndexTitle {
  std::string title;
};

// The importer's own parse of index.json is authoritative; this one only has to
// see the title early enough to refuse it. A failure here is deliberately not
// reported: the import runs anyway and fails with the importer's own message.
std::optional<std::string> peek_title(const std::string& zip_path) {
  Zip zip;
  if (!zip.open(std::filesystem::path{zip_path})) {
    return std::nullopt;
  }
  const int index_entry = zip.find("index.json");
  if (index_entry < 0) {
    return std::nullopt;
  }
  const std::string index_json = zip.read(index_entry);
  WireIndexTitle index;
  if (glz::read<glz::opts{.error_on_unknown_keys = false}>(index, std::string_view{index_json})) {
    return std::nullopt;
  }
  return index.title;
}

// Moves the staged dictionary onto `destination` without ever leaving it half
// replaced: the previous import is moved aside first and only dropped once the
// new one is in place, which is what makes a failed re-import survivable.
void install_dictionary(const std::filesystem::path& staged, const std::filesystem::path& destination,
                        const std::filesystem::path& aside) {
  const bool replacing = std::filesystem::exists(destination);
  if (replacing) {
    std::filesystem::rename(destination, aside);
  }
  try {
    std::filesystem::rename(staged, destination);
  } catch (...) {
    if (replacing) {
      std::error_code error;
      std::filesystem::rename(aside, destination, error);
    }
    throw;
  }
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

  if (const auto peeked = peek_title(zip_path); peeked.has_value() && !usable_as_directory_name(*peeked)) {
    report.title = *peeked;
    report.error = unusable_title_error(*peeked);
    return report;
  }

  const std::filesystem::path staging = root / STAGING_DIR;
  const RemoveOnExit cleanup{staging};
  const std::filesystem::path work = staging / STAGING_WORK;
  std::error_code error;
  // Debris from an import the browser killed halfway through.
  std::filesystem::remove_all(staging, error);
  std::filesystem::create_directories(work);

  report = report_for(dictionary_importer::import(zip_path, work.string(), low_ram));
  if (!report.success) {
    return report;
  }
  if (!usable_as_directory_name(report.title)) {
    report.success = false;
    report.error = unusable_title_error(report.title);
    return report;
  }
  const std::filesystem::path staged = work / report.title;
  if (!dictionary_files_present(staged)) {
    report.success = false;
    report.error = "the import produced no loadable dictionary";
    return report;
  }
  try {
    install_dictionary(staged, root / report.title, staging / STAGING_REPLACED);
  } catch (const std::exception& e) {
    report.success = false;
    report.error = std::string{"could not install the imported dictionary: "} + e.what();
  }
  return report;
}

std::vector<uint8_t> g_media;

}  // namespace hdw

using namespace hdw;

extern "C" {

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
    switch (kind) {
      case 0:
        e.query.add_term_dict(dict_path);
        break;
      case 1: {
        const size_t before = e.query.get_freq_dict_order().size();
        e.query.add_freq_dict(dict_path);
        if (e.query.get_freq_dict_order().size() == before) {
          set_error("frequency dictionary rejected: " + dict_path);
          return 0;
        }
        break;
      }
      case 2:
        e.query.add_pitch_dict(dict_path);
        break;
      default:
        e.query.add_kanji_dict(dict_path);
        break;
    }
    e.dictionary_count += 1;
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

    const std::string query_text{text == nullptr ? "" : text};
    if (!query_text.empty() && max_results > 0 && scan_length > 0) {
      const LookupOptions options = parse_options(options_json);
      // Four-argument overload: the sort preferences have to apply before the
      // max_results cap, otherwise ranking is decided by an arbitrary prefix.
      const auto results =
          e.lookup.lookup(query_text, max_results, static_cast<size_t>(scan_length), options);
      response.results.reserve(results.size());
      for (const auto& result : results) {
        response.results.push_back(convert_result(result));
      }
    }
    out = to_json(response);
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
    const std::string kanji{character == nullptr ? "" : character};
    if (!kanji.empty()) {
      KanjiResult result = engine().query.query_kanji(kanji);
      wire.entries.reserve(result.entries.size());
      for (const auto& entry : result.entries) {
        WireKanjiEntry out_entry;
        out_entry.dictionary = entry.dict_name;
        out_entry.onyomi = entry.onyomi;
        out_entry.kunyomi = entry.kunyomi;
        out_entry.tags = entry.tags;
        out_entry.definitions = entry.definitions;
        out_entry.stats.reserve(entry.stats.size());
        for (const auto& [name, value] : entry.stats) {
          out_entry.stats.push_back({name, value});
        }
        // stats arrive from an unordered_map; sort so the rendered order is stable.
        std::ranges::sort(out_entry.stats, {}, &WireKanjiStat::name);
        wire.entries.push_back(std::move(out_entry));
      }
      // Empty character is the contract's "nothing matched" sentinel.
      if (!wire.entries.empty()) {
        wire.character = result.character;
      }
    }
    out = to_json(wire);
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
    const MediaFileView view = engine().query.get_media_file_view(dictionary, path);
    if (view.data == nullptr || view.size == 0) {
      return 0;
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
