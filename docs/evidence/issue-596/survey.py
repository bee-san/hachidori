#!/usr/bin/env python3
# Survey for hachidori #596: counts only; no dictionary data is kept or published.
#   python3 survey.py <pitch dictionary archive>...
# For each archive: how many pitches are downstep numbers and how many are H/L
# strings, how many strings rise again after a fall (several accent phrases),
# and the positions of a few probe words.
#
# SPDX-License-Identifier: GPL-3.0-or-later
import collections, json, re, sys, zipfile
# These archives carry wrong CRC-32 fields; the data inflates correctly.
zipfile.ZipExtFile._update_crc = lambda self, data: None
PROBES = ['二十四時間', '十人十色', '一子相伝', '一石二鳥', '月雪花', '悲喜こもごも', '昭和', '橋', '非人間的', '日本語能力試験']
MULTI = re.compile(r'HL+H')
def banks(path):
    z = zipfile.ZipFile(path)
    index = json.loads(z.read('index.json').decode('utf-8-sig')) if 'index.json' in z.namelist() else {}
    for info in z.infolist():
        if re.search(r'(^|/)term_meta_bank_\d+\.json$', info.filename):
            yield index, json.loads(z.read(info).decode('utf-8-sig'))
for path in sys.argv[1:]:
    title = None; kinds = collections.Counter(); multi = 0; strings = 0; ints = 0; entries = 0; multi_entries = 0; probes = {}
    examples = []
    for index, rows in banks(path):
        title = index.get('title')
        for row in rows:
            if len(row) < 3 or row[1] != 'pitch' or not isinstance(row[2], dict): continue
            entries += 1
            positions = [p.get('position') for p in row[2].get('pitches', [])]
            any_multi = False
            for value in positions:
                if isinstance(value, str):
                    strings += 1
                    if MULTI.search(value): multi += 1; any_multi = True
                else: ints += 1
            if any_multi:
                multi_entries += 1
                if len(examples) < 6: examples.append((row[0], row[2].get('reading'), positions))
            if row[0] in PROBES: probes.setdefault(row[0], []).append((row[2].get('reading'), positions))
    print(json.dumps({'file': path, 'title': title, 'entries': entries, 'int_pitches': ints, 'string_pitches': strings,
        'multi_phrase_string_pitches': multi, 'entries_with_multi_phrase': multi_entries, 'examples': examples, 'probes': probes}, ensure_ascii=False))
