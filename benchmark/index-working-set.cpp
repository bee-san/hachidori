// SPDX-License-Identifier: GPL-3.0-or-later
// A lower bound on the exact-key index pages the fixed corpus touches. Prefix
// and deinflection probes, Bloom false positives and entry pages add to it.
#define XXH_INLINE_ALL
#include <xxh3.h>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iostream>
#include <set>
#include <string>

int main(int argc, char** argv) {
  if (argc != 3) return 1;
  std::ifstream input(argv[1], std::ios::binary), corpus(argv[2]);
  std::string file(std::istreambuf_iterator<char>(input), {}), word;
  uint32_t capacity;
  if (file.size() < 4) return 1;
  std::memcpy(&capacity, file.data(), 4);
  if (!capacity || file.size() != 4 + uint64_t{capacity} * 16) return 1;
  std::set<uint64_t> pages;
  while (std::getline(corpus, word)) {
    if (!word.starts_with("測定")) continue; // Known exact hits; no Bloom-negative pages.
    const auto hash = XXH3_64bits(word.data(), word.size());
    auto pos = hash % capacity;
    for (uint64_t count = 0; count < capacity; ++count) {
      const auto offset = 4 + pos * 16;
      pages.insert(offset / 4096);
      pages.insert((offset + 15) / 4096);
      uint64_t stored;
      std::memcpy(&stored, file.data() + offset, 8);
      if (!stored || stored == hash) break;
      pos = (pos + 1) % capacity;
    }
  }
  std::cout << pages.size() << '\n';
}
