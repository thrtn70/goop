import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
test('desktop entry has no blocking remote startup stylesheets or font connections', () => {
  const html = readFileSync(new URL('index.html', root), 'utf8');
  assert.doesNotMatch(html, /<link\b[^>]*href=["']https?:/i);
});
test('brand fonts use bundled variable assets and retain their licenses', () => {
  const css = readFileSync(new URL('src/styles/fonts.css', root), 'utf8');
  assert.doesNotMatch(css, /https?:/);
  for (const family of ['Bricolage Grotesque', 'Figtree']) assert.ok(css.includes(family));
  const urls = [...css.matchAll(/url\(["']([^"']+)["']\)/g)].map(match => match[1]);
  assert.ok(urls.length >= 2);
  for (const url of urls) assert.ok(existsSync(fileURLToPath(new URL(url, new URL('src/styles/fonts.css', root)))));
  for (const name of ['bricolage-grotesque', 'figtree']) {
    assert.match(readFileSync(new URL(`src/assets/fonts/${name}-OFL.txt`, root), 'utf8'), /SIL OPEN FONT LICENSE/);
  }
});
import { createHash } from 'node:crypto';
test('bundled font bytes match the retained upstream provenance', () => {
  const manifest = JSON.parse(readFileSync(new URL('src/assets/fonts/provenance.json', root), 'utf8'));
  for (const family of Object.values(manifest)) {
    assert.equal(family.metadata.license.type, 'OFL-1.1');
    for (const [filename, expected] of Object.entries(family.files_sha256)) {
      const bytes = readFileSync(new URL(`src/assets/fonts/${filename}`, root));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
    }
  }
});
test('desktop bundles carry the full copyright and font license notices', () => {
  const config = JSON.parse(readFileSync(new URL('src-tauri/tauri.conf.json', root), 'utf8'));
  for (const family of ['bricolage-grotesque', 'figtree']) {
    assert.equal(config.bundle.resources[`../src/assets/fonts/${family}-OFL.txt`], `licenses/fonts/${family}-OFL.txt`);
  }
});
test('desktop bundle carries the libwebp binary redistribution notice', () => {
  const config = JSON.parse(readFileSync(new URL('src-tauri/tauri.conf.json', root), 'utf8'));
  assert.equal(
    config.bundle.resources['licenses/libwebp-COPYING.txt'],
    'licenses/libwebp-COPYING.txt',
  );
  const notice = readFileSync(new URL('src-tauri/licenses/libwebp-COPYING.txt', root), 'utf8');
  assert.match(notice, /Copyright \(c\) 2010, Google Inc\. All rights reserved\./);
  assert.match(notice, /Redistributions? in binary form must reproduce/);
  assert.match(notice, /THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS/);
});
