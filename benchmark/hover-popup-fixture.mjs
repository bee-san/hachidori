// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFileSync } from 'node:fs';
import { buildTitledZip } from '../test/make-fixture.mjs';

// The deep-nesting case wraps its gloss in 40 nested elements, past the depth
// real monolingual dictionaries reach (#287); the other two entries stay flat.
let deepNesting = '深層の語義';
for (let level = 0; level < 40; level += 1) deepNesting = { tag: level % 2 ? 'div' : 'span', content: [deepNesting] };

writeFileSync(process.argv[2], buildTitledZip('hover-popup-fixture', { terms: [
  ['食べる', 'たべる', '', 'v1', 100, ['食べる　漢字'], 1, ''],
  ['漢字', 'かんじ', '', '', 100, ['食べる　漢字'], 2, ''],
  ['深層', 'しんそう', '', '', 100, [{ type: 'structured-content', content: deepNesting }], 3, ''],
] }));
