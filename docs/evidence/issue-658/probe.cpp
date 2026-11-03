// probe.cpp (hachi-issue-658): native lookups over Hachidori's default
// dictionary set, as the #620 audit imported it.
//
//   probe show <dicts_dir> <text>...      every result, option off then on
//   probe count <dicts_dir> <inputs>      per input: results off/on, how many
//                                         metadata-only results on, whether the
//                                         first result or the defined results'
//                                         order changed; summary on stderr
//   probe dump <dicts_dir> <inputs> on|off one line per result
//
// Loaded as the engine service loads the five recommended dictionaries: term
// Jitendex, JMnedict, Bee's Ultimate Kanji Dictionary, Bee's Ultimate Grammar
// Dictionary; frequency Bee's Ultimate Kanji Dictionary and Jiten; in
// recommended-dictionaries.js order.
#include <hoshidicts/deinflector.hpp>
#include <hoshidicts/lookup.hpp>
#include <hoshidicts/query.hpp>

#include <cstdio>
#include <fstream>
#include <iostream>
#include <string>
#include <vector>

namespace {
std::string describe(const LookupResult& r) {
  std::string out = r.matched + " -> " + r.term.expression + "/" + r.term.reading;
  out += r.term.glossaries.empty() ? " [no definitions]" : " [" + std::to_string(r.term.glossaries.size()) + " defs]";
  for (const auto& f : r.term.frequencies) {
    out += " " + f.dict_name + ":";
    for (const auto& v : f.frequencies) out += v.display_value.empty() ? std::to_string(v.value) : v.display_value;
  }
  for (const auto& p : r.term.pitches) {
    out += " pitch " + p.dict_name + ":";
    for (const auto& a : p.pitches) out += std::to_string(a.position) + ",";
  }
  return out;
}

std::vector<std::string> read_lines(const std::string& path) {
  std::vector<std::string> out;
  std::ifstream in(path);
  for (std::string line; std::getline(in, line);) out.push_back(line);
  return out;
}

uint64_t fnv(const std::string& s) {
  uint64_t h = 1469598103934665603ull;
  for (unsigned char c : s) {
    h ^= c;
    h *= 1099511628211ull;
  }
  return h;
}

// Every field of a result (glossary text as FNV-1a 64), for dump.
std::string line_of(const LookupResult& r) {
  std::string out = r.matched + "|" + r.deinflected + "|";
  for (const auto& g : r.trace) out += g.name + ",";
  out += "|" + std::to_string(r.preprocessor_steps) + "|" + r.term.expression + "|" + r.term.reading + "|" +
         r.term.rules + "|" + std::to_string(r.term.score) + "|G";
  for (const auto& g : r.term.glossaries) {
    out += g.dict_name + ":" + g.definition_tags + ":" + g.term_tags + ":" + std::to_string(fnv(g.glossary)) + ":" +
           std::to_string(g.score) + ";";
  }
  out += "|F";
  for (const auto& f : r.term.frequencies) {
    out += f.dict_name + ":";
    for (const auto& v : f.frequencies) out += std::to_string(v.value) + "/" + v.display_value + ",";
    out += ";";
  }
  out += "|P";
  for (const auto& p : r.term.pitches) {
    out += p.dict_name + ":";
    for (const auto& a : p.pitches) out += std::to_string(a.position) + "/" + a.pattern + ",";
    for (const auto& t : p.transcriptions) out += "ipa=" + t + ",";
    out += ";";
  }
  return out;
}

void load(DictionaryQuery& query, const std::string& dir) {
  const std::string jitendex = dir + "/Jitendex.org [2026-10-03]";
  const std::string jmnedict = dir + "/JMnedict [2026-10-31]";
  const std::string kanji = dir + "/Bee's Ultimate Kanji Dictionary";
  const std::string jiten = dir + "/Jiten";
  const std::string grammar = dir + "/Bee's Ultimate Grammar Dictionary";
  const bool ok = query.add_term_dict(jitendex) && query.add_term_dict(jmnedict) && query.add_term_dict(kanji) &&
                  query.add_freq_dict(kanji) && query.add_freq_dict(jiten) && query.add_term_dict(grammar) &&
                  query.set_dict_order({jitendex, jmnedict, kanji, jiten, grammar});
  if (!ok) {
    std::cerr << "load failed\n";
    std::exit(2);
  }
}
}  // namespace

int main(int argc, char** argv) {
  if (argc < 4) return 1;
  const std::string mode = argv[1];
  DictionaryQuery query;
  load(query, argv[2]);
  Deinflector deinflector;
  Lookup lookup(query, deinflector);
  LookupOptions off;
  LookupOptions on;
  on.metadata_only_terms = true;
  if (mode == "show") {
    for (int i = 3; i < argc; ++i) {
      for (const auto* options : {&off, &on}) {
        std::cout << "== " << argv[i] << (options->metadata_only_terms ? " (on)" : " (off)") << "\n";
        for (const auto& r : lookup.lookup(argv[i], 32, 16, *options)) std::cout << "  " << describe(r) << "\n";
      }
    }
    return 0;
  }
  const auto inputs = read_lines(argv[3]);
  if (mode == "dump") {
    const bool use_on = argc > 4 && std::string(argv[4]) == "on";
    for (const auto& text : inputs) {
      std::cout << "= " << text << "\n";
      for (const auto& r : lookup.lookup(text, 32, 16, use_on ? on : off)) std::cout << line_of(r) << "\n";
    }
    return 0;
  }
  if (mode == "count") {
    size_t total = 0, changed = 0, first_changed = 0, defined_order_bad = 0, with_meta = 0, meta_results = 0;
    size_t off_results = 0, on_results = 0;
    for (const auto& text : inputs) {
      const auto a = lookup.lookup(text, 32, 16, off);
      const auto b = lookup.lookup(text, 32, 16, on);
      ++total;
      off_results += a.size();
      on_results += b.size();
      std::vector<std::string> defined_on;
      size_t meta = 0;
      for (const auto& r : b) {
        if (r.term.glossaries.empty()) {
          ++meta;
        } else {
          defined_on.push_back(r.term.expression + "/" + r.term.reading);
        }
      }
      // The defined results on must be the off results, cut only at the end.
      bool prefix = defined_on.size() <= a.size();
      for (size_t i = 0; prefix && i < defined_on.size(); ++i) {
        prefix = defined_on[i] == a[i].term.expression + "/" + a[i].term.reading;
      }
      if (!prefix) ++defined_order_bad;
      if (meta > 0) ++with_meta;
      meta_results += meta;
      const auto key = [](const std::vector<LookupResult>& v) {
        return v.empty() ? std::string() : v[0].term.expression + "/" + v[0].term.reading;
      };
      if (key(a) != key(b)) ++first_changed;
      if (a.size() != b.size() || meta > 0) ++changed;
      std::cout << text << "\t" << a.size() << "\t" << b.size() << "\t" << meta << "\t" << (key(a) != key(b)) << "\n";
    }
    std::fprintf(stderr,
                 "inputs %zu; with metadata-only results %zu (%.2f%%); metadata-only results %zu; first result "
                 "changed %zu (%.2f%%); defined order not off's prefix %zu; results off %zu on %zu\n",
                 total, with_meta, 100.0 * with_meta / total, meta_results, first_changed,
                 100.0 * first_changed / total, defined_order_bad, off_results, on_results);
    return 0;
  }
  return 1;
}
