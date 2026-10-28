#!/usr/bin/env python3
#   python3 kanjium_lists.py <Kanjium Pitch Accents archive> <NHK日本語発音アクセント新辞典 archive>
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Survey for hachidori #596 (counts only, nothing kept): Kanjium Pitch Accents
# lists several downstep numbers for some readings. NHK日本語発音アクセント新辞典
# (a term dictionary) writes each pronunciation of a headword as ［n］, and one
# of several accent phrases as ［n・m］. Which of Kanjium's lists are NHK's
# alternative accents and which are NHK's phrases? Only an entry's head block
# is read: its later blocks are conjugated forms and particle examples. An
# entry spelt "A，B" (お舟，お船) counts for each spelling.
import collections, json, re, sys, zipfile

zipfile.ZipExtFile._update_crc = lambda self, data: None


def rows(path, kind):
    archive = zipfile.ZipFile(path)
    for info in archive.infolist():
        if re.search(rf'(^|/){kind}_\d+\.json$', info.filename):
            yield from json.loads(archive.read(info).decode('utf-8-sig'))


kanjium, nhk = sys.argv[1], sys.argv[2]
pronunciations = collections.defaultdict(set)
for row in rows(nhk, 'term_bank'):
    for text in row[5]:
        if not isinstance(text, str):
            continue
        for line in text.split('\n\n')[0].split('\n')[1:]:
            match = re.match(r'^ ・［([0-9・]+)］', line)
            if match:
                accents = tuple(int(value) for value in match.group(1).split('・'))
                for spelling in row[0].split('，'):
                    pronunciations[(spelling, row[1])].add(accents)


def kind(positions, nhk_prons):
    if not nhk_prons:
        return 'not in NHK'
    phrases = [p for p in nhk_prons if len(p) > 1]
    alternatives = {p[0] for p in nhk_prons if len(p) == 1}
    if tuple(positions) in phrases:
        return "phrases: NHK's phrase accents" + (', NHK has no other' if len(nhk_prons) == 1 else ', NHK has others too')
    if set(positions) == alternatives and not phrases:
        return "alternatives: exactly NHK's one-phrase accents"
    if set(positions) <= alternatives:
        return "alternatives: some of NHK's one-phrase accents"
    if set(positions) & alternatives:
        return "partly NHK's one-phrase accents"
    return 'none of NHK\'s accents' + (', NHK has phrases' if phrases else '')


counts = collections.Counter()
examples = collections.defaultdict(list)
for expression, kind_name, data in rows(kanjium, 'term_meta_bank'):
    if kind_name != 'pitch':
        continue
    positions = [pitch['position'] for pitch in data['pitches']]
    if len(positions) < 2:
        continue
    nhk_prons = pronunciations.get((expression, data['reading']), set())
    name = kind(positions, nhk_prons)
    counts[name] += 1
    if len(examples[name]) < 3:
        examples[name].append(f'{expression} {positions} NHK {sorted(nhk_prons)}')
print(f'{sum(counts.values())} Kanjium lists of two or more numbers')
for name, count in counts.most_common():
    print(f'{count:7d}  {name}  e.g. {"; ".join(examples[name])}')
