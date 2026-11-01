// Hovers over real text for bee-san/hachidori#620 (not committed): every
// window of a novel, looked up as a hover would (max 32 results, scan 16, Auto
// order) with LookupOptions::metadata_only_terms off and on. Reports how often
// the first result becomes frequency-only.
#include "hoshidicts/deinflector.hpp"
#include "hoshidicts/lookup.hpp"
#include "hoshidicts/query.hpp"

#include <algorithm>
#include <cstdio>
#include <fstream>
#include <string>
#include <vector>

int main(int argc, char** argv) {
  if (argc < 3) {
    std::fprintf(stderr, "%s <windows.txt> --term <path>... --freq <path>...\n", argv[0]);
    return 2;
  }
  std::vector<std::string> windows;
  {
    std::ifstream in(argv[1]);
    std::string line;
    while (std::getline(in, line)) {
      if (!line.empty()) windows.push_back(line);
    }
  }
  DictionaryQuery query;
  std::vector<std::string> order;
  bool freq = false;
  for (int i = 2; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--term") {
      freq = false;
    } else if (arg == "--freq") {
      freq = true;
    } else {
      if (!(freq ? query.add_freq_dict(arg) : query.add_term_dict(arg))) return 1;
      if (std::ranges::find(order, arg) == order.end()) order.push_back(arg);
    }
  }
  query.set_dict_order(order);
  Deinflector deinflector;
  Lookup lookup(query, deinflector);
  LookupOptions on;
  on.metadata_only_terms = true;
  size_t changed = 0;
  size_t off_hits = 0;
  std::vector<std::string> examples;
  for (const auto& window : windows) {
    if (!lookup.lookup(window, 32, 16).empty()) ++off_hits;
    const auto b = lookup.lookup(window, 32, 16, on);
    if (!b.empty() && b[0].term.glossaries.empty()) {
      ++changed;
      if (examples.size() < 60) examples.push_back(b[0].matched);
    }
  }
  std::printf("windows %zu, with a result off %zu\n", windows.size(), off_hits);
  std::printf("hovers whose first result becomes frequency-only with the option on: %zu (%.2f%%)\n", changed,
              100.0 * static_cast<double>(changed) / static_cast<double>(windows.size()));
  std::printf("examples:");
  for (const auto& example : examples) std::printf(" %s", example.c_str());
  std::printf("\n");
  return 0;
}
