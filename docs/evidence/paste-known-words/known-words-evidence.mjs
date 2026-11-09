import assert from 'node:assert/strict';
import test from 'node:test';
import { startSession, page, showSettingsSection, writeOptions, readStorage, waitFor } from '../firefox-e2e/session.mjs';

test('paste known words in real Firefox and capture Settings', async () => {
  await startSession();
  await showSettingsSection(page, 'word-highlighting');
  const paste = text => page.evaluate(value => {
    const input = document.getElementById('known-words-input');
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }, text);
  const capture = async name => {
    await page.evaluate(async () => {
      document.getElementById('known-words-input').closest('fieldset').scrollIntoView({ block: 'center' });
      await document.fonts.ready;
    });
    const clip = await page.evaluate(() => {
      const rect = document.getElementById('known-words-input').closest('fieldset').getBoundingClientRect();
      const top = document.getElementById('known-words-heading').getBoundingClientRect().top - 4;
      return { x: rect.x + scrollX, y: top + scrollY, width: rect.width, height: rect.bottom - top + 2 };
    });
    await page.screenshot({ path: `test/tmp/known-words-${name}.png`, clip });
  };
  await writeOptions(page, { popupTheme: 'light' });
  await paste('食べる\n可愛い\n学校\n学校\n');
  await capture('light');
  await page.click('#known-words-add');
  assert.ok(await waitFor(() => page.evaluate(() => document.getElementById('known-words-status').textContent === '3 words marked as known.')));
  const stored = (await readStorage(page, ['wordStatusOverrides'])).wordStatusOverrides;
  assert.deepEqual(stored, { revision: 1, known: ['食べる', '可愛い', '学校'], ignored: [] });
  await writeOptions(page, { popupTheme: 'dark' });
  await capture('dark');
  await paste(' 食べる \n学校');
  await page.click('#known-words-add');
  assert.ok(await waitFor(() => page.evaluate(() => document.getElementById('known-words-status').textContent === 'All pasted words are already known.')));
  assert.deepEqual((await readStorage(page, ['wordStatusOverrides'])).wordStatusOverrides, stored);
  console.log('Verified live Settings paste, duplicate handling, feedback and one stored revision.');
});
