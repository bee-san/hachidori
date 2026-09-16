// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFileSync } from 'node:fs';
import { buildTitledZip } from '../test/make-fixture.mjs';

writeFileSync(process.argv[2], buildTitledZip('hover-popup-fixture', { terms: [
  ['食べる', 'たべる', '', 'v1', 100, ['食べる　漢字'], 1, ''],
  ['漢字', 'かんじ', '', '', 100, ['食べる　漢字'], 2, ''],
] }));
