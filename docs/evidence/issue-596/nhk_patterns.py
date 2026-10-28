#!/usr/bin/env python3
# Evidence for hachidori #596: no dictionary data is stored or published.
#
#   python3 nhk_patterns.py <NHK日本語発音アクセント新辞典 archive> <out.jsonl>
#
# The NHK new accent dictionary (a Yomitan term dictionary) writes each
# pronunciation as [a・b…] and katakana with ＼ at each drop and ・ between
# accent phrases: 二十四時間 is ［1・2］ニ＼ジュー・ヨジ＼カン. This writes each
# pronunciation of an entry's head block whose morae match the reading as the
# Yomitan H/L pattern a dictionary would give it, one level per mora from
# Yomitan's isMoraPitchHigh for each phrase's own accent, without and with the
# following particle's level, with each phrase's own accent group.
#
# An entry's later blocks (after a blank line) are its conjugated forms and
# particle examples (覚える: オボ＼エテ), not the headword's pronunciations, so
# they are not read. Nor are template entries: 第○日 だい○にち and 日間
# かかん，にちかん have empty head blocks, and a suffix template's reading (〜あい)
# is not kana.
#
# SPDX-License-Identifier: GPL-3.0-or-later
import json, re, sys, zipfile

# Several archives in circulation carry wrong CRC-32 fields; the data inflates.
zipfile.ZipExtFile._update_crc = lambda self, data: None

SMALL = set('ゃゅょぁぃぅぇぉゎャュョァィゥェォヮ')
KANA = re.compile(r'[\u3041-\u309a\u30a1-\u30fcー]+')


def morae(kana):
    # The renderer's splitPitchAccentMorae: a small kana or a combining mark
    # (the nasal ゚) joins the mora before it.
    out = []
    for ch in kana:
        if out and (ch in SMALL or ch == '\u309a'):
            out[-1] += ch
        else:
            out.append(ch)
    return out


def high(index, accent):
    # Yomitan's isMoraPitchHigh (japanese.js:350 at d3c54c1) for a number.
    if accent == 0:
        return index > 0
    if accent == 1:
        return index < 1
    return 0 < index < accent


def group(accent, count):
    # Yomitan's getPitchCategory for a noun phrase.
    if accent == 0:
        return 'heiban'
    if accent == 1:
        return 'atamadaka'
    return 'odaka' if accent >= count else 'nakadaka'


def rows(path):
    archive = zipfile.ZipFile(path)
    for info in archive.infolist():
        if re.search(r'(^|/)term_bank_\d+\.json$', info.filename):
            yield from json.loads(archive.read(info).decode('utf-8-sig'))


archive, out = sys.argv[1], sys.argv[2]
seen = set()
counts = {'kept': 0, 'kept, several phrases': 0, 'skipped: reading not kana': 0,
          'skipped: pronunciation not kana': 0, 'skipped: morae differ from the reading': 0}
with open(out, 'w', encoding='utf-8') as file:
    for row in rows(archive):
        expression, reading = row[0], row[1]
        # ・ in a reading (韓国・朝鮮語) is not a mora; ○, 〜 and ， are not kana.
        reading_kana = reading.replace('・', '')
        for text in row[5]:
            if not isinstance(text, str):
                continue
            for line in text.split('\n\n')[0].split('\n')[1:]:
                match = re.match(r'^ ・［([0-9・]+)］([^,]*)', line)
                if not match:
                    continue
                if not KANA.fullmatch(reading_kana):
                    counts['skipped: reading not kana'] += 1
                    continue
                accents = [int(value) for value in match.group(1).split('・')]
                phrases = match.group(2).replace('＼', '').split('・')
                if len(phrases) != len(accents) or not all(KANA.fullmatch(p) for p in phrases):
                    counts['skipped: pronunciation not kana'] += 1
                    continue
                lengths = [len(morae(p)) for p in phrases]
                if sum(lengths) != len(morae(reading_kana)) or any(a > c for a, c in zip(accents, lengths)):
                    counts['skipped: morae differ from the reading'] += 1
                    continue
                key = (expression, reading, tuple(accents), tuple(lengths))
                if key in seen:
                    continue
                seen.add(key)
                levels = ''.join('H' if high(i, a) else 'L' for a, c in zip(accents, lengths) for i in range(c))
                particle = 'H' if high(lengths[-1], accents[-1]) else 'L'
                counts['kept'] += 1
                counts['kept, several phrases'] += len(accents) > 1
                file.write(json.dumps({
                    'expression': expression, 'reading': reading, 'accents': accents, 'phraseMorae': lengths,
                    'pattern': levels, 'patternWithParticle': levels + particle,
                    'phraseGroups': [group(a, c) for a, c in zip(accents, lengths)],
                }, ensure_ascii=False) + '\n')
print(json.dumps(counts, ensure_ascii=False))
