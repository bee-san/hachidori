#!/usr/bin/env python3
# Survey for hachidori #608: no dictionary data is kept or published.
# For each Drive file id: download, read only the term banks' expression,
# reading and rules, print the rules of a few probe words and how many rows
# carry a verb/i-adjective class on an expression that cannot be in that
# class's dictionary form. The archive is deleted afterwards.
import collections, io, json, subprocess, sys, zipfile, os, re

PROBES = ['自由', '静か', '綺麗', '料理', '授業', '好き', '大切', '元気', '勉強', '心配']
END = {'v1': ('る',), 'v5': tuple('うくぐすつぬぶむる'), 'vk': ('くる', '来る', '來る'),
       'vs': ('する', '為る'), 'vz': ('ずる',), 'adj-i': ('い',)}

def hira(s):
    return ''.join(chr(ord(c) - 0x60) if 'ァ' <= c <= 'ヶ' else c for c in s)

def survey(name, file_id):
    path = f'/tmp/hachi-608/survey-{file_id}.zip'
    subprocess.run(['curl', '-sL', '-A', 'Mozilla/5.0', '--max-time', '900', '-o', path,
                    f'https://drive.usercontent.google.com/download?id={file_id}&export=download&confirm=t'],
                   check=False, stdin=subprocess.DEVNULL)
    try:
        z = zipfile.ZipFile(path)
    except Exception as error:  # noqa: BLE001
        return {'name': name, 'error': str(error)}
    probes = collections.defaultdict(set)
    total = collections.Counter()
    mismatched = collections.Counter()
    examples = collections.defaultdict(list)
    rules_counter = collections.Counter()
    for info in z.infolist():
        if not re.search(r'(^|/)term_bank_\d+\.json$', info.filename):
            continue
        try:
            rows = json.loads(z.read(info).decode('utf-8'))
        except Exception:  # noqa: BLE001
            continue
        for row in rows:
            if not isinstance(row, list) or len(row) < 4:
                continue
            expression, reading, rules = str(row[0]), str(row[1] or row[0]), str(row[3] or '')
            rules_counter[rules] += 1
            if expression in PROBES:
                probes[f'{expression}|{reading}'].add(rules)
            for rule in rules.split():
                if rule in END:
                    total[rule] += 1
                    if not hira(expression).endswith(END[rule]):
                        mismatched[rule] += 1
                        if len(examples[rule]) < 6:
                            examples[rule].append(f'{expression}|{reading}')
    z.close()
    os.remove(path)
    return {'name': name, 'probes': {k: sorted(v) for k, v in probes.items()},
            'classes': {r: [total[r], mismatched[r], examples[r]] for r in END if total[r]},
            'topRules': rules_counter.most_common(8)}

for line in sys.stdin:
    name, _, file_id = line.rstrip('\n').rpartition('\t')
    if file_id:
        print(json.dumps(survey(name, file_id), ensure_ascii=False), flush=True)
