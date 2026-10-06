// SPDX-License-Identifier: GPL-3.0-or-later
//
// C ABI shim exposing the hoshidicts C++ engine to JavaScript. Everything that
// crosses into wasm is a NUL-terminated JSON string owned by a function-local
// static, valid until the next call to the same function.

#include <algorithm>
#include <array>
#include <bit>
#include <cerrno>
#include <climits>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <exception>
#include <filesystem>
#include <fstream>
#include <malloc.h>
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
#include "scan_index.hpp"
#include "zip/zip.hpp"

// Not an anonymous namespace: glaze's field-name reflection takes the address of
// an `extern const T` sentinel, which requires T to have external linkage.
namespace hdw {

struct WireCacheActivity { size_t bytes; uint64_t hits; uint64_t reads; uint64_t readBytes; };
struct WireMemoryStats {
  WireCacheActivity entries;
  WireCacheActivity indexes;
  size_t pageCacheBudgetBytes;
  size_t liveAllocatedBytes;
  size_t allocatorFreeBytes;
};

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
  // kanji_meta_bank frequencies, in frequency-dictionary order.
  std::vector<WireFrequencyEntry> frequencies;
};

struct WireStyle {
  std::string dictionary;
  std::string styles;
};

// A term dictionary's tag-bank rows (name, category, order, notes, score) as
// the importer stored them in its index.json.
struct WireTags {
  std::string dictionary;
  std::vector<SummaryTag> tags;
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
  // What a successful MDX import left out (ImportResult::warnings); always 0
  // for a Yomitan archive.
  uint64_t skippedRecordCount = 0;
  uint64_t unresolvedRedirectCount = 0;
  uint64_t missingResourceCount = 0;
  uint64_t unreadableResourceCount = 0;
  std::string error;
};

std::string g_last_error;
int g_storage_mode = -1;

void clear_error() { g_last_error.clear(); }

void set_error(std::string message) { g_last_error = std::move(message); }

// Anything thrown past here aborts the whole module and takes the extension's
// offscreen document with it, so every ABI entry point funnels through this.
// Each caller is a catch (...) handler; rethrowing the exception it is handling
// recovers that exception's message.
std::string describe_current_exception() {
  try {
    std::rethrow_exception(std::current_exception());
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

std::vector<WireFrequencyEntry> convert_frequencies(const std::vector<FrequencyEntry>& frequencies,
                                                    LookupCopyBudget& budget) {
  std::vector<WireFrequencyEntry> out;
  out.reserve(frequencies.size());
  for (const auto& f : frequencies) {
    WireFrequencyEntry entry;
    entry.dictionary = copy_lookup_string(f.dict_name, budget, "frequency dictionary");
    entry.frequencies.reserve(f.frequencies.size());
    for (const auto& v : f.frequencies) {
      entry.frequencies.emplace_back(v.value, copy_lookup_string(v.display_value, budget, "frequency display value"));
    }
    out.push_back(std::move(entry));
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

  out.frequencies = convert_frequencies(term.frequencies, budget);

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

// ---------------------------------------------------------------------------
// Segmentation (#520): a line of text split into the dictionary words a hover
// would show, so a page's words can be marked by their Anki status.
//
// Every code point starts one deinflecting lookup, with the hover's dictionaries,
// order and options; each distinct matched length there is a word that could
// start at it. The split chosen covers the most text with dictionary words,
// then uses the fewest words, then the most frequent ones by the frequency
// dictionary a lookup ranks with, and then prefers the longer word first, which
// is the greedy longest-match parse when nothing else tells two splits apart.

// Offsets and lengths count UTF-16 code units, as DOM text offsets do.
struct WireSegmentCandidate {
  std::string expression;
  std::string reading;
};

// One word of a span's alternative split.
struct WireSegmentWord {
  size_t start = 0;
  size_t length = 0;
  bool functionWord = false;
  std::vector<WireSegmentCandidate> candidates;
};

struct WireSegmentSpan {
  size_t start = 0;
  size_t length = 0;
  bool functionWord = false;
  // The headwords a hover on the span would list for its length, in the
  // hover's order: the first is the popup's first result.
  std::vector<WireSegmentCandidate> candidates;
  // The best split of the span's text into shorter words, when one covers all
  // of it (今日は as 今日 and は); empty otherwise.
  std::vector<WireSegmentWord> alternative;
};

struct WireSegmentResponse {
  std::vector<WireSegmentSpan> spans;
};

// Particles, the copula, sentence-final particles and conjunctions. A span
// whose text or first headword is one of these is a function word, which the
// page leaves unmarked. Jitendex carries part of speech only inside its
// structured glossaries, not in the tags or rules hoshidicts returns, so the
// words are listed here.
constexpr std::array FUNCTION_WORDS = std::to_array<std::string_view>({
    "が", "を", "に", "へ", "で", "と", "から", "より", "まで", "の", "は", "も",
    "こそ", "さえ", "でも", "しか", "だけ", "ばかり", "など", "なんか", "くらい", "ぐらい",
    "ほど", "って", "とか", "やら", "ずつ", "て", "ば", "ても", "けど", "けれど",
    "けれども", "し", "ので", "のに", "ながら", "たり", "か", "ね", "ねえ", "よ",
    "な", "なあ", "ぞ", "ぜ", "わ", "さ", "かな", "かしら", "よね", "っけ",
    "や", "には", "では", "とは", "にも", "でも", "へと", "だ", "です", "である",
    "じゃ", "じゃない", "ではない", "ん", "のだ", "んだ", "のです", "んです", "そして", "しかし",
    "だから", "それで", "でも", "また", "だが", "ところが", "すると",
});

bool is_function_word(std::string_view surface, std::string_view headword) {
  return std::ranges::find(FUNCTION_WORDS, surface) != std::ranges::end(FUNCTION_WORDS)
         || std::ranges::find(FUNCTION_WORDS, headword) != std::ranges::end(FUNCTION_WORDS);
}

// The byte and UTF-16 offset of every code point boundary of a text.
struct TextIndex {
  std::vector<size_t> bytes;
  std::vector<size_t> utf16;

  size_t codepoints() const { return bytes.size() - 1; }
};

// The number of bytes a UTF-8 code point starting with `lead` occupies, or 0
// when `lead` is not a valid leading byte.
size_t utf8_width(unsigned char lead) {
  if (lead < 0x80) return 1;
  if (lead >= 0xC2 && lead < 0xE0) return 2;
  if (lead >= 0xE0 && lead < 0xF0) return 3;
  if (lead >= 0xF0 && lead < 0xF5) return 4;
  return 0;
}

bool is_utf8_continuation(char byte) {
  return (static_cast<unsigned char>(byte) & 0xC0) == 0x80;
}

TextIndex index_text(std::string_view text) {
  TextIndex index;
  size_t utf16 = 0;
  for (size_t i = 0; i < text.size();) {
    const size_t width = utf8_width(static_cast<unsigned char>(text[i]));
    if (width == 0 || i + width > text.size()
        || !std::ranges::all_of(text.substr(i + 1, width - 1), is_utf8_continuation)) {
      throw std::invalid_argument("segment text is not valid UTF-8");
    }
    index.bytes.push_back(i);
    index.utf16.push_back(utf16);
    // Code points outside the BMP (four UTF-8 bytes) are one surrogate pair.
    utf16 += width == 4 ? 2 : 1;
    i += width;
  }
  index.bytes.push_back(text.size());
  index.utf16.push_back(utf16);
  return index;
}

// The frequency dictionary that breaks ties between splits: the one a lookup
// with the same options ranks its results by first.
struct SegmentFrequency {
  std::optional<std::string> dictionary;
  bool descending = false;
};

SegmentFrequency segment_frequency(const DictionaryQuery& query, const LookupOptions& options) {
  using enum LookupFrequencyOrder;
  const std::vector<std::string> order = query.get_freq_dict_order();
  switch (options.frequency_order) {
    case Auto:
      if (!order.empty()) {
        return {order.front(), false};
      }
      break;
    case Ascending:
    case Descending:
      if (options.frequency_dictionary.has_value() && std::ranges::find(order, *options.frequency_dictionary) != order.end()) {
        return {options.frequency_dictionary, options.frequency_order == Descending};
      }
      break;
    case Disabled:
      break;
  }
  return {};
}

// A word's share of a split's frequency cost: the logarithm of its rank, so
// two splits compare like the product of their words' ranks (Zipf). A word
// with no value counts as INT_MAX, as a lookup's own ranking treats it; an
// occurrence count counts down from there.
double frequency_cost(std::optional<int> value, bool descending) {
  const double missing = std::log(static_cast<double>(INT_MAX));
  if (!value.has_value()) {
    return missing;
  }
  const double logarithm = std::log(static_cast<double>(std::max(*value, 1)));
  return descending ? missing - logarithm : logarithm;
}

std::optional<int> term_frequency(const TermResult& term, const SegmentFrequency& frequency) {
  std::optional<int> best;
  for (const auto& entry : term.frequencies) {
    if (entry.dict_name != *frequency.dictionary) {
      continue;
    }
    for (const auto& value : entry.frequencies) {
      if (value.value < 0) {
        continue;
      }
      if (!best.has_value() || (frequency.descending ? value.value > *best : value.value < *best)) {
        best = value.value;
      }
    }
  }
  return best;
}

// The words that can start at one code point: one per distinct matched length,
// longest first.
struct SegmentMatch {
  size_t codepoints = 0;
  double frequency = 0;
  std::optional<int> best_value;
  std::vector<WireSegmentCandidate> candidates;
};

using SegmentLattice = std::vector<std::vector<SegmentMatch>>;

// Thrown for a segmentation invariant that a correct engine never violates;
// hdw_segment's catch turns it into an error string rather than aborting.
class SegmentError : public std::runtime_error {
 public:
  using std::runtime_error::runtime_error;
};

// The code-point length of the matched prefix of a lookup result that started
// at `start`, checked to end on a code-point boundary.
size_t matched_codepoints(const TextIndex& index, size_t start, const LookupResult& result) {
  const size_t stop = index.bytes[start] + result.matched.size();
  const auto boundary = std::ranges::lower_bound(index.bytes, stop);
  if (boundary == index.bytes.end() || *boundary != stop) {
    throw SegmentError("a lookup matched part of a code point");
  }
  return static_cast<size_t>(boundary - index.bytes.begin()) - start;
}

// Merges one lookup result into the matches that can start at a position,
// keeping its candidates and the best frequency value for its length.
void record_match(std::vector<SegmentMatch>& matches, size_t codepoints, const LookupResult& result,
                  const SegmentFrequency& frequency, LookupCopyBudget& budget) {
  auto match = std::ranges::find(matches, codepoints, &SegmentMatch::codepoints);
  if (match == matches.end()) {
    match = matches.insert(matches.end(), SegmentMatch{.codepoints = codepoints});
  }
  match->candidates.emplace_back(copy_lookup_string(result.term.expression, budget, "term expression"),
                                 copy_lookup_string(result.term.reading, budget, "term reading"));
  if (!frequency.dictionary.has_value()) {
    return;
  }
  const std::optional<int> value = term_frequency(result.term, frequency);
  if (value.has_value()
      && (!match->best_value.has_value()
          || (frequency.descending ? *value > *match->best_value : *value < *match->best_value))) {
    match->best_value = value;
  }
}

SegmentLattice build_lattice(const Engine& e, std::string_view text, const TextIndex& index, size_t scan_length,
                             const LookupOptions& options, LookupCopyBudget& budget) {
  const SegmentFrequency frequency = segment_frequency(e.query, options);
  // The hover hands the engine the scan length, or a long key's length plus
  // room for its inflection when a dictionary lists keys longer than that
  // (content.js scanWindow); the lookup reaches past the scan only then.
  const size_t long_key = e.query.max_long_key_length();
  const size_t window =
      long_key == 0 ? scan_length : std::max(scan_length, long_key + scan_index::inflection_slack_codepoints);
  SegmentLattice lattice(index.codepoints());
  for (size_t start = 0; start < index.codepoints(); ++start) {
    const size_t end = std::min(index.codepoints(), start + window);
    const std::string slice{text.substr(index.bytes[start], index.bytes[end] - index.bytes[start])};
    auto& matches = lattice[start];
    // Every result, so that each matched length keeps its candidates.
    for (const auto& result : e.lookup.lookup(slice, INT_MAX, scan_length, options)) {
      record_match(matches, matched_codepoints(index, start, result), result, frequency, budget);
    }
    for (auto& match : matches) {
      match.frequency = frequency.dictionary.has_value() ? frequency_cost(match.best_value, frequency.descending) : 0;
    }
    std::ranges::stable_sort(matches, std::greater{}, &SegmentMatch::codepoints);
  }
  return lattice;
}

struct SplitCost {
  size_t unmatched = 0;
  size_t words = 0;
  double frequency = 0;
};

bool cheaper(const SplitCost& a, const SplitCost& b) {
  if (a.unmatched != b.unmatched) {
    return a.unmatched < b.unmatched;
  }
  if (a.words != b.words) {
    return a.words < b.words;
  }
  // Sums of logarithms: equal ranks summed in another order must still tie.
  return a.frequency < b.frequency - 1e-9 * std::max(1.0, std::abs(b.frequency));
}

// The cheapest split of the code points [from, to) and the first step of it
// at each position: the index of the word there, or nullopt for a character
// no word covers. `excluded` is a word length the split may not start with.
struct SplitStep {
  SplitCost cost;
  std::optional<size_t> match;
};

std::vector<SplitStep> best_split(const SegmentLattice& lattice, size_t from, size_t to, size_t excluded = 0) {
  std::vector<SplitStep> best(to - from + 1);
  for (size_t position = to; position-- > from;) {
    SplitStep& step = best[position - from];
    const auto& matches = lattice[position];
    // Longest first, so that only a strictly cheaper shorter word replaces it.
    for (size_t index = 0; index < matches.size(); ++index) {
      const SegmentMatch& word = matches[index];
      if (position + word.codepoints > to || (position == from && word.codepoints == excluded)) {
        continue;
      }
      SplitCost cost = best[position + word.codepoints - from].cost;
      cost.words += 1;
      cost.frequency += word.frequency;
      if (!step.match.has_value() || cheaper(cost, step.cost)) {
        step = {cost, index};
      }
    }
    SplitCost skipped = best[position + 1 - from].cost;
    skipped.unmatched += 1;
    if (!step.match.has_value() || cheaper(skipped, step.cost)) {
      step = {skipped, std::nullopt};
    }
  }
  return best;
}

template <typename Word>
Word segment_word(std::string_view text, const TextIndex& index, size_t position, const SegmentMatch& match) {
  const size_t stop = position + match.codepoints;
  const std::string_view surface = text.substr(index.bytes[position], index.bytes[stop] - index.bytes[position]);
  Word word;
  word.start = index.utf16[position];
  word.length = index.utf16[stop] - index.utf16[position];
  word.functionWord = is_function_word(surface, match.candidates.front().expression);
  word.candidates = match.candidates;
  return word;
}

// The best split of a span's own code points into shorter words, when one
// covers all of them (今日は -> 今日 + は); empty when the span is one code
// point or no gap-free shorter split exists.
std::vector<WireSegmentWord> alternative_split(const SegmentLattice& lattice, std::string_view text,
                                               const TextIndex& index, size_t position, size_t stop) {
  std::vector<WireSegmentWord> alternative;
  if (stop - position <= 1) {
    return alternative;
  }
  const std::vector<SplitStep> parts = best_split(lattice, position, stop, stop - position);
  if (parts.front().cost.unmatched != 0) {
    return alternative;
  }
  for (size_t part = position; part < stop;) {
    const SegmentMatch& word = lattice[part][*parts[part - position].match];
    alternative.push_back(segment_word<WireSegmentWord>(text, index, part, word));
    part += word.codepoints;
  }
  return alternative;
}

WireSegmentResponse segment(const Engine& e, std::string_view text, size_t scan_length, const LookupOptions& options,
                            LookupCopyBudget& budget) {
  const TextIndex index = index_text(text);
  const SegmentLattice lattice = build_lattice(e, text, index, scan_length, options, budget);
  const std::vector<SplitStep> best = best_split(lattice, 0, index.codepoints());
  WireSegmentResponse response;
  for (size_t position = 0; position < index.codepoints();) {
    const std::optional<size_t> chosen = best[position].match;
    if (!chosen.has_value()) {
      position += 1;
      continue;
    }
    const SegmentMatch& match = lattice[position][*chosen];
    const size_t stop = position + match.codepoints;
    auto span = segment_word<WireSegmentSpan>(text, index, position, match);
    span.alternative = alternative_split(lattice, text, index, position, stop);
    response.spans.push_back(std::move(span));
    position = stop;
  }
  return response;
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

// The loader maps a package's index files, and its blobs.bin unless the
// package is paged, into linear memory (Emscripten's mmap copies them in), and
// a refused memory.grow surfaces only as MAP_FAILED with errno ENOMEM (WasmFS
// syscalls.cpp _mmap_js; classic FS FS.ErrnoError(ENOMEM)). Callers zero errno
// before the add so that case reads differently from a damaged package; the
// extension retries it paged (engine-service.js addDictionaryKind).
std::string rejected_dictionary(const char* kind, const std::string& dict_path) {
  if (errno == ENOMEM) {
    return std::string{"not enough memory to load "} + kind + " dictionary: " + dict_path;
  }
  return std::string{kind} + " dictionary rejected: " + dict_path
      + (engine().query.last_error().empty() ? "" : ": " + engine().query.last_error());
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

// A package lives in folder_name(title) (hoshidicts/importer.hpp), which is
// the title itself unless the title is not one plain path component. The
// internal staging directories cannot also be dictionary destinations.
bool usable_dictionary_title(std::string_view title) {
  if (title.empty()) {
    return false;
  }
  const std::string folder = dictionary_importer::folder_name(title);
  return folder != STAGING_DIR && folder != REMOVAL_DIR;
}

std::string unusable_title_error(std::string_view title) {
  if (title.empty()) {
    return "the archive declares no dictionary title";
  }
  return "the dictionary title \"" + std::string{title} +
         "\" is reserved for Hachidori's own files";
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
  errno = 0;
  if (!zip.open(std::filesystem::path{zip_path})) {
    if (errno == ENOMEM) {
      error = "not enough memory to read the dictionary archive";
    } else {
      error = zip.error.empty() ? "failed to open zip" : zip.error;
    }
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
  // A kanji_meta_bank frequency makes the package a frequency dictionary too,
  // which is the kind query_kanji reads kanji frequencies from.
  report.frequencyCount = meta_count(counts.termMeta, "freq") + meta_count(counts.kanjiMeta, "freq");
  report.pitchCount = meta_count(counts.termMeta, "pitch") + meta_count(counts.termMeta, "ipa");
  report.kanjiCount = counts.kanji.total;
  report.mediaCount = counts.media.total;
  report.skippedRecordCount = result.warnings.skippedRecords;
  report.unresolvedRedirectCount = result.warnings.unresolvedRedirects;
  report.missingResourceCount = result.warnings.missingResources;
  report.unreadableResourceCount = result.warnings.unreadableResources;
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
  // before the import. The importer writes to folder_name(title), one plain
  // path component, so it cannot leave `work`; the post-import check below
  // applies to an MDict title too.
  if (!looks_like_mdict(zip_path)) {
    std::string title;
    if (!peek_title(zip_path, title, report.error)) {
      return report;
    }
    const std::filesystem::path staged = (work / dictionary_importer::folder_name(title)).lexically_normal();
    if (!usable_dictionary_title(title) || staged.parent_path() != work.lexically_normal()) {
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
  if (!usable_dictionary_title(report.title)) {
    report.success = false;
    report.error = unusable_title_error(report.title);
    return report;
  }
  const std::string folder = dictionary_importer::folder_name(report.title);
  const std::filesystem::path imported = work / folder;
  if (!dictionary_files_present(imported)) {
    report.success = false;
    report.error = "the import produced no loadable dictionary";
    return report;
  }
  try {
    flush_tree(imported);
    install_dictionary(imported, root / folder, staging / STAGING_REPLACED / folder);
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
          R"("pitchCount":0,"kanjiCount":0,"mediaCount":0,"skippedRecordCount":0,"unresolvedRedirectCount":0,)"
          R"("missingResourceCount":0,"unreadableResourceCount":0,"error":"report serialization failed"})";
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

EMSCRIPTEN_KEEPALIVE int hdw_add_dict(const char* path, int kind, int paged, int index_paged) {
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
    // Paged reads blobs.bin on demand instead of copying it into the heap
    // (DictionaryStorage in hoshidicts/query.hpp). A kind added after another
    // kind of the same package shares that kind's files either way.
    const DictionaryStorage storage = paged != 0 ? DictionaryStorage::Paged : DictionaryStorage::Mapped;
    const auto index_storage = index_paged != 0 ? DictionaryIndexStorage::Paged : DictionaryIndexStorage::Mapped;
    errno = 0;
    switch (kind) {
      case 0:
        if (!e.query.add_term_dict(dict_path, storage, index_storage)) {
          set_error(rejected_dictionary("term", dict_path));
          return 0;
        }
        e.term_paths.push_back(dict_path);
        break;
      case 1:
        if (!e.query.add_freq_dict(dict_path, storage, index_storage)) {
          set_error(rejected_dictionary("frequency", dict_path));
          return 0;
        }
        break;
      case 2:
        if (!e.query.add_pitch_dict(dict_path, storage, index_storage)) {
          set_error(rejected_dictionary("pitch", dict_path));
          return 0;
        }
        break;
      default:
        if (!e.query.add_kanji_dict(dict_path, storage, index_storage)) {
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

// Splits `text` into the words a hover would show, as {"spans": [...]}; see
// WireSegmentSpan. `scan_length` and `options_json` are the hover lookup's.
EMSCRIPTEN_KEEPALIVE const char* hdw_segment(const char* text, int scan_length, const char* options_json) {
  static std::string out;
  clear_error();

  try {
    WireSegmentResponse response;
    LookupCopyBudget budget;
    if (const std::string_view segment_text{text == nullptr ? "" : text};
        !segment_text.empty() && scan_length > 0) {
      require_lookup_text_size(segment_text, "segment text");
      const LookupOptions options = parse_options(options_json);
      response = segment(engine(), segment_text, static_cast<size_t>(scan_length), options, budget);
    }
    out = lookup_json(response, budget);
  } catch (...) {
    set_error(describe_current_exception());
    out = R"({"spans":[]})";
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
      // Empty character is the contract's "nothing matched" sentinel. A
      // frequency alone is not a kanji entry to show.
      if (!wire.entries.empty()) {
        wire.character = copy_lookup_string(result.character, budget, "kanji character");
        wire.frequencies = convert_frequencies(result.frequencies, budget);
      }
    }
    out = lookup_json(wire, budget);
  } catch (...) {
    set_error(describe_current_exception());
    out = R"({"character":"","entries":[],"frequencies":[]})";
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

EMSCRIPTEN_KEEPALIVE const char* hdw_tags(void) {
  static std::string out;
  clear_error();

  try {
    const auto dictionaries = engine().query.get_tags();
    std::vector<WireTags> wire;
    wire.reserve(dictionaries.size());
    for (const auto& d : dictionaries) {
      wire.emplace_back(d.dict_name, d.tags);
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
    // Read out of media.bin, which the engine never copies into the heap, into
    // a buffer that also survives a later hdw_reset.
    if (std::string_view{dictionary}.size() > MAX_MEDIA_DICTIONARY_BYTES) {
      throw std::length_error("media dictionary exceeds the 1024-byte limit");
    }
    if (std::string_view{path}.size() > MAX_MEDIA_PATH_BYTES) {
      throw std::length_error("media path exceeds the 4096-byte limit");
    }
    const size_t size = engine().query.read_media_file(dictionary, path, g_media, MAX_MEDIA_BYTES);
    if (size == 0) {
      return 0;
    }
    if (size > MAX_MEDIA_BYTES) {
      throw std::length_error("media exceeds the 4 MiB byte limit");
    }
    return static_cast<int>(g_media.size());
  } catch (...) {
    set_error(describe_current_exception());
    g_media.clear();
    return 0;
  }
}

EMSCRIPTEN_KEEPALIVE const uint8_t* hdw_media_data(void) { return g_media.data(); }

// Bytes of blobs.bin pages the engine holds for paged dictionaries.
EMSCRIPTEN_KEEPALIVE double hdw_page_cache_bytes(void) {
  try {
    return static_cast<double>(engine().query.page_cache_bytes());
  } catch (...) {
    return 0;
  }
}

// The shared page cache split into entry and hash pages (hdw_page_cache_bytes
// is their sum), the budget of Engine's default-constructed query, and the
// allocator's live and free bytes inside the heap.
EMSCRIPTEN_KEEPALIVE const char* hdw_memory_stats(void) {
  static std::string out;
  const auto stats = engine().query.page_cache_statistics();
  // Emscripten's libc provides mallinfo only; glibc's replacement, mallinfo2, does not exist there.
  const auto allocated = mallinfo();  // NOSONAR(cpp:S1874)
  const WireMemoryStats wire{{stats.entries.bytes, stats.entries.hits, stats.entries.reads, stats.entries.read_bytes},
                   {stats.indexes.bytes, stats.indexes.hits, stats.indexes.reads, stats.indexes.read_bytes},
                   PageCacheOptions{}.budget_bytes,
                   static_cast<size_t>(allocated.uordblks), static_cast<size_t>(allocated.fordblks)};
  (void)glz::write_json(wire, out);
  return out.c_str();
}

EMSCRIPTEN_KEEPALIVE int hdw_hash_index_paged(const char* path) {
  return path != nullptr && engine().query.hash_index_paged(path) ? 1 : 0;
}

}  // extern "C"
