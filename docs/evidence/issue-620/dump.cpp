// Dumps every lookup result of every input line, so two builds can be compared
// byte for byte (bee-san/hachidori#620, not committed). With METADATA=1 the
// branch build turns LookupOptions::metadata_only_terms on.
#include "hoshidicts/deinflector.hpp"
#include "hoshidicts/lookup.hpp"
#include "hoshidicts/query.hpp"

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>
#include <vector>

int main(int argc, char** argv) {
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
      bool seen = false;
      for (const auto& path : order) seen = seen || path == arg;
      if (!seen) order.push_back(arg);
    }
  }
  query.set_dict_order(order);
  Deinflector deinflector;
  Lookup lookup(query, deinflector);
  LookupOptions options;
#ifdef BRANCH
  options.metadata_only_terms = std::getenv("METADATA") != nullptr;
#endif
  std::ifstream in(argv[1]);
  std::string line;
  while (std::getline(in, line)) {
    if (line.empty()) continue;
    std::printf("= %s\n", line.c_str());
    for (const auto& r : lookup.lookup(line, 32, 16, options)) {
      std::printf("%s|%s|%d|%s|%s|%s|%.17g|", r.matched.c_str(), r.deinflected.c_str(), r.preprocessor_steps,
                  r.term.expression.c_str(), r.term.reading.c_str(), r.term.rules.c_str(), r.term.score);
      for (const auto& t : r.trace) std::printf("%s>", t.name.c_str());
      std::printf("|");
      for (const auto& g : r.term.glossaries) {
        std::printf("%s:%zu:%s:%s;", g.dict_name.c_str(), g.glossary.size(), g.definition_tags.c_str(),
                    g.term_tags.c_str());
      }
      std::printf("|");
      for (const auto& f : r.term.frequencies) {
        std::printf("%s:", f.dict_name.c_str());
        for (const auto& v : f.frequencies) std::printf("%d/%s,", v.value, v.display_value.c_str());
        std::printf(";");
      }
      std::printf("|");
      for (const auto& p : r.term.pitches) {
        std::printf("%s:", p.dict_name.c_str());
        for (const auto& v : p.pitches) std::printf("%d/%s,", v.position, v.pattern.c_str());
        std::printf(";");
      }
      std::printf("\n");
    }
  }
  return 0;
}
