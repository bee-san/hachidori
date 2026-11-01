// Default-installation measurement for bee-san/hachidori#620 (not committed).
// Imports the five recommended dictionaries, then looks up every distinct
// expression of the default frequency dictionary (Jiten) with
// LookupOptions::metadata_only_terms off and on, as a hover on exactly that
// word would, and reports how often the option adds a frequency-only result.
#include "hoshidicts/deinflector.hpp"
#include "hoshidicts/importer.hpp"
#include "hoshidicts/lookup.hpp"
#include "hoshidicts/query.hpp"

#include <utf8.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <map>
#include <random>
#include <string>
#include <vector>

struct Word {
  std::string text;
  int value;
};

int main(int argc, char** argv) {
  if (argc < 4) {
    std::fprintf(stderr, "%s <out_dir> <words.tsv> <zip>...\n", argv[0]);
    return 2;
  }
  const std::filesystem::path out_dir = argv[1];
  std::filesystem::create_directories(out_dir);
  DictionaryQuery query;
  std::vector<std::string> order;
  for (int i = 3; i < argc; ++i) {
    const auto result = dictionary_importer::import(argv[i], out_dir.string());
    if (!result.success) {
      std::fprintf(stderr, "import %s failed: %s\n", argv[i], result.error.c_str());
      return 1;
    }
    const auto& counts = result.summary.counts;
    const auto meta = [&](const char* mode) {
      const auto it = counts.termMeta.find(mode);
      return it == counts.termMeta.end() ? size_t{0} : it->second;
    };
    const std::string path = (out_dir / dictionary_importer::folder_name(result.summary.title)).string();
    order.push_back(path);
    std::printf("imported %-40s terms %zu freq %zu pitch %zu ipa %zu kanji %zu\n", result.summary.title.c_str(),
                counts.terms.total, meta("freq"), meta("pitch"), meta("ipa"), counts.kanji.total);
    if (counts.terms.total > 0 && !query.add_term_dict(path)) return 1;
    if (meta("freq") > 0 && !query.add_freq_dict(path)) return 1;
    if (meta("pitch") + meta("ipa") > 0 && !query.add_pitch_dict(path)) return 1;
    if (counts.kanji.total > 0 && !query.add_kanji_dict(path)) return 1;
  }
  query.set_dict_order(order);

  std::vector<Word> words;
  {
    std::ifstream in(argv[2]);
    std::string line;
    while (std::getline(in, line)) {
      const auto tab = line.find('\t');
      words.push_back({line.substr(0, tab), std::stoi(line.substr(tab + 1))});
    }
  }
  std::printf("words %zu\n", words.size());

  Deinflector deinflector;
  Lookup lookup(query, deinflector);
  LookupOptions off;
  LookupOptions on;
  on.metadata_only_terms = true;
  const auto scan = [](const std::string& text) {
    return std::max<size_t>(16, utf8::distance(text.begin(), text.end()));
  };
  const auto key = [](const LookupResult& r) { return r.matched + "|" + r.term.expression + "|" + r.term.reading; };

  size_t unknown_text = 0;  // no term entry has the word as its expression or reading
  size_t added = 0;         // a hover on the word gains a frequency-only result
  size_t off_empty = 0;     // of those, how many had no result at all without the option
  size_t inconsistent = 0;  // the option changed anything but put metadata-only results in front
  std::map<int, size_t> by_rank;
  const int buckets[] = {1000, 5000, 10000, 20000, 50000, 100000, 200000, 500000};
  std::vector<const Word*> examples;
  for (const auto& word : words) {
    if (query.query(word.text).empty()) ++unknown_text;
    const auto a = lookup.lookup(word.text, 32, scan(word.text), off);
    const auto b = lookup.lookup(word.text, 32, scan(word.text), on);
    size_t metadata = 0;
    while (metadata < b.size() && b[metadata].term.glossaries.empty()) ++metadata;
    for (size_t i = metadata; i < b.size(); ++i) {
      if (b[i].term.glossaries.empty()) ++inconsistent;
    }
    for (size_t i = metadata; i < b.size(); ++i) {
      if (i - metadata >= a.size() || key(b[i]) != key(a[i - metadata])) {
        ++inconsistent;
        break;
      }
    }
    if (metadata == 0) {
      if (a.size() != b.size()) ++inconsistent;
      continue;
    }
    ++added;
    if (a.empty()) ++off_empty;
    for (int limit : buckets) {
      if (word.value <= limit) {
        ++by_rank[limit];
        break;
      }
    }
    examples.push_back(&word);
  }
  std::printf("words no term entry has as an expression or reading: %zu\n", unknown_text);
  std::printf("words whose exact-word hover gains a frequency-only result: %zu (%.2f%%)\n", added,
              100.0 * static_cast<double>(added) / static_cast<double>(words.size()));
  std::printf("  of which had no result at all without the option: %zu\n", off_empty);
  std::printf("lists that changed other than by results without glossaries in front: %zu\n", inconsistent);
  int previous = 0;
  for (int limit : buckets) {
    std::printf("  rank %6d-%6d: %zu\n", previous + 1, limit, by_rank[limit]);
    previous = limit;
  }
  std::printf("most frequent examples:");
  for (size_t i = 0; i < std::min<size_t>(40, examples.size()); ++i) {
    std::printf(" %s(%d)", examples[i]->text.c_str(), examples[i]->value);
  }
  std::printf("\n");
  std::mt19937 rng(620);
  std::shuffle(examples.begin(), examples.end(), rng);
  std::printf("random examples:");
  for (size_t i = 0; i < std::min<size_t>(40, examples.size()); ++i) {
    std::printf(" %s(%d)", examples[i]->text.c_str(), examples[i]->value);
  }
  std::printf("\n");
  return 0;
}
