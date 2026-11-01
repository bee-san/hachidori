# Builds the 494,979 lookup inputs of the #620 byte comparison: one 16-character
# hover per character of the first 40,000 characters of 吾輩は猫である, the
# windows of hachidori's segmentation reference lines (windows.txt, written by
# windows.mjs), and every distinct Jiten expression.
import glob, json, re, sys, zipfile
work = sys.argv[1]
text = zipfile.ZipFile(f'{work}/neko.zip').read('wagahaiwa_nekodearu.txt').decode('shift_jis', errors='replace')
parts = text.split('-------------------------------------------------------')
body = (parts[2] if len(parts) > 2 else text).split('底本：')[0]
body = re.sub(r'《[^》]*》', '', body)
body = re.sub(r'［＃[^］]*］', '', body).replace('｜', '')
prose = ''.join(line.strip() for line in body.splitlines() if line.strip())[:40000]
neko = [prose[i:i + 16] for i in range(len(prose))]
rows = json.loads(zipfile.ZipFile(f'{work}/dicts/jiten-frequency.zip').read('term_meta_bank_1.json'))
best = {}
for expression, mode, data in rows:
    value = data['frequency']['value'] if 'reading' in data else data['value']
    best[expression] = min(value, best.get(expression, value))
jiten = [expression for expression, value in sorted(best.items(), key=lambda kv: (kv[1], kv[0]))]
open(f'{work}/neko-windows.txt', 'w', encoding='utf-8').write('\n'.join(neko) + '\n')
open(f'{work}/jiten-expressions.tsv', 'w', encoding='utf-8').write(
    ''.join(f'{e}\t{best[e]}\n' for e in jiten))
windows = open(f'{work}/windows.txt', encoding='utf-8').read().splitlines()
open(f'{work}/all-inputs.txt', 'w', encoding='utf-8').write('\n'.join(neko + windows + jiten) + '\n')
print('neko', len(neko), 'reference windows', len(windows), 'jiten', len(jiten), 'total', len(neko) + len(windows) + len(jiten))
