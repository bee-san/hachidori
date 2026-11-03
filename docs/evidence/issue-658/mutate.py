import sys
src = open(sys.argv[1], encoding="utf-8").read()
m = sys.argv[2]
subs = {
  "M2-no-defined_as": ("if (readings.empty() && reading_less && !defined_as(text)) {", "if (readings.empty() && reading_less) {"),
  "M3-merge-by_rank": ("std::ranges::merge(kept, metadata, std::back_inserter(merged), by_length);", "std::ranges::merge(metadata, kept, std::back_inserter(merged), by_rank);"),
  "M5-no-primary": ("      if (!primary_reading.empty()) {\n        const bool primary_a = matches_primary_reading(*a.term, primary_reading);", "      if (false) {\n        const bool primary_a = matches_primary_reading(*a.term, primary_reading);"),
  "M6-metadata-first": ("std::ranges::merge(kept, metadata, std::back_inserter(merged), by_length);", "std::ranges::merge(metadata, kept, std::back_inserter(merged), by_length);"),
}
a, b = subs[m]
assert src.count(a) == 1, m
open(sys.argv[1], "w", encoding="utf-8").write(src.replace(a, b))
