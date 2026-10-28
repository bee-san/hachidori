#!/usr/bin/env python3
#   python3 kanjium_lists.py <Kanjium Pitch Accents archive> <NHK日本語発音アクセント新辞典 archive>
#
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Survey for hachidori #596 (counts only, nothing kept): Kanjium Pitch Accents
# lists several positions for one reading. NHK日本語発音アクセント新辞典 (a term
# dictionary) writes each pronunciation as ［n］, and a word of several accent
# phrases as ［n・m］. Which of Kanjium's lists are NHK's phrase sequences?
import collections, json, re, sys, zipfile
zipfile.ZipExtFile._update_crc = lambda self, data: None
kanjium, nhk = sys.argv[1], sys.argv[2]
def rows(path, kind):
    z = zipfile.ZipFile(path)
    for info in z.infolist():
        if re.search(rf'(^|/){kind}_\d+\.json$', info.filename):
            yield from json.loads(z.read(info).decode('utf-8-sig'))
pron = collections.defaultdict(list)
for row in rows(nhk, 'term_bank'):
    for text in row[5]:
        if not isinstance(text, str): continue
        for bracket in re.findall(r'・［([^］]+)］', text):
            parts = bracket.split('・')
            if all(p.isdigit() for p in parts):
                pron[(row[0], row[1])].append(tuple(int(p) for p in parts))
counts = collections.Counter(); examples = collections.defaultdict(list)
for row in rows(kanjium, 'term_meta_bank'):
    if row[1] != 'pitch': continue
    reading = row[2]['reading']; positions = [p['position'] for p in row[2]['pitches']]
    key = (row[0], reading)
    nhk_prons = sorted(set(pron.get(key, [])))
    if not nhk_prons:
        counts['multi: not in NHK' if len(positions) > 1 else 'single: not in NHK'] += 1; continue
    multi_ap = [p for p in nhk_prons if len(p) > 1]
    if len(positions) > 1:
        if len(nhk_prons) == 1 and multi_ap and list(multi_ap[0]) == positions: kind = 'multi: NHK phrase sequence'
        elif not multi_ap and set(positions) == {p[0] for p in nhk_prons}: kind = 'multi: NHK alternatives'
        elif multi_ap: kind = 'multi: other, NHK has phrases'
        else: kind = 'multi: other'
    else:
        kind = 'single: NHK has phrases' if multi_ap else 'single: NHK single phrase'
    counts[kind] += 1
    if len(examples[kind]) < 5: examples[kind].append((row[0], reading, positions, nhk_prons))
for kind, n in sorted(counts.items()): print(f'{n:7d}  {kind}  e.g. {examples[kind][:3]}')
print('NHK readings with a multi-phrase pronunciation:', sum(1 for v in pron.values() if any(len(p) > 1 for p in v)), 'of', len(pron))
