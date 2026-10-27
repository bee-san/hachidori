#!/usr/bin/env python3
# Benchmark input for hachidori #608: as dump.py, but every (expression,
# reading) of the term dictionaries that has a pitch, with or without word
# classes, so the timing sees the mix a lookup sees.
import collections, glob, json, re, sys, zipfile

def rows_of(source, kind):
    pattern = re.compile(rf'(^|/){kind}_\d+\.json$')
    if source.endswith('.zip'):
        z = zipfile.ZipFile(source)
        for info in z.infolist():
            if pattern.search(info.filename):
                try:
                    yield from json.loads(z.read(info).decode('utf-8'))
                except Exception:  # noqa: BLE001 (a corrupt bank)
                    pass
    else:
        for path in glob.glob(f'{source}/**/{kind}_*.json', recursive=True):
            try:
                yield from json.load(open(path, encoding='utf-8'))
            except Exception:  # noqa: BLE001
                pass

terms, pitch_sources, out = sys.argv[1].split(','), sys.argv[2].split(','), sys.argv[3]
classes = collections.defaultdict(list)
for source in terms:
    for row in rows_of(source, 'term_bank'):
        rules = str(row[3] or '').strip()
        classes[(str(row[0]), str(row[1] or row[0]))].append(rules)
pitches = collections.defaultdict(list)
for source in pitch_sources:
    if source.endswith('accents.txt'):
        for line in open(source, encoding='utf-8'):
            parts = line.rstrip('\n').split('\t')
            if len(parts) >= 3:
                pitches[(parts[0], parts[1] or parts[0])] += [int(v) for v in parts[2].split(',') if v.strip().isdigit()]
        continue
    for row in rows_of(source, 'term_meta_bank'):
        if len(row) >= 3 and row[1] == 'pitch' and isinstance(row[2], dict):
            reading = row[2].get('reading') or row[0]
            pitches[(row[0], reading)] += [p.get('position') for p in row[2].get('pitches', [])
                                           if isinstance(p.get('position'), (int, str))]
with open(out, 'w', encoding='utf-8') as file:
    for key, rules in classes.items():
        if key in pitches:
            file.write(json.dumps({'expression': key[0], 'reading': key[1], 'rules': ' '.join(rules),
                                   'pitches': sorted(set(map(str, pitches[key])))}, ensure_ascii=False) + '\n')
