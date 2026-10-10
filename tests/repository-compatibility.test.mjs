import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProvenance, validateWebOutput } from '../src/repository.mjs';
import { localGameHtml } from '../src/game-policy.mjs';
import { prepareRepositoryBatch } from './repository-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const batch = path.join(root, '.omni', 'tmp', 'windows-trial', 'repository-tests');
const fixture = path.join(batch, 'compatibility');
const groupOwner = 'anything-hub-repository-compatibility';
const cases = {
  gpl: ['LICENSE'],
  agpl: ['LICENSE'],
  optional: ['index.html', 'game.css', 'app.js'],
  'missing-stylesheet': ['index.html'],
  'missing-script': ['index.html'],
  'missing-manifest': ['index.html'],
  'missing-preload': ['index.html'],
  'missing-image': ['index.html'],
  'unsafe-icon': ['index.html'],
  hardlink: ['index.html', 'original.png'],
};
const allowed = new Set(['fixture-owner.json', ...Object.entries(cases).flatMap(([name, files]) => [name, ...files.map(file => name + '/' + file)])]);

function inspect(target, relative = '') {
  const stat = fs.lstatSync(target);
  assert.equal(stat.isSymbolicLink(), false, 'No links in this fixture group: ' + target);
  if (stat.isFile()) assert.equal(stat.nlink, 1, 'No unowned hard links: ' + target);
  if (relative) assert.ok(allowed.has(relative), 'Preserve unknown fixture content: ' + target);
  if (stat.isDirectory()) for (const name of fs.readdirSync(target)) inspect(path.join(target, name), relative ? relative + '/' + name : name);
}
async function prepare() {
  for (let current = fixture; ; current = path.dirname(current)) {
    if (fs.existsSync(current)) assert.equal(fs.lstatSync(current).isSymbolicLink(), false, 'Linked ancestor: ' + current);
    if (current === root) break;
    assert.ok(current.startsWith(root + path.sep), 'Fixture stays in the canonical project batch');
  }
  await prepareRepositoryBatch(root, batch);
  const ownerPath = path.join(fixture, 'fixture-owner.json');
  if (fs.existsSync(fixture)) {
    inspect(fixture);
    assert.ok(fs.existsSync(ownerPath), 'Existing group must have its exact owner');
    assert.equal(JSON.parse(fs.readFileSync(ownerPath, 'utf8')).owner, groupOwner);
  } else {
    fs.mkdirSync(fixture);
    fs.writeFileSync(ownerPath, JSON.stringify({ owner: groupOwner, fixture, batch, role: 'repository compatibility fixtures', files: [...allowed] }, null, 2), { flag: 'wx' });
  }
  for (const name of Object.keys(cases)) {
    const directory = path.join(fixture, name);
    if (!fs.existsSync(directory)) fs.mkdirSync(directory);
  }
}
function write(name, file, value) {
  assert.ok(cases[name]?.includes(file), 'Only explicitly owned fixture paths may be written');
  const target = path.join(fixture, name, file);
  if (fs.existsSync(target)) {
    const stat = fs.lstatSync(target);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(stat.nlink, 1);
    assert.ok(stat.isFile());
  }
  fs.writeFileSync(target, value);
  return target;
}
function html(markup) { return '<!doctype html><html><head><title>Compatibility fixture</title>' + markup + '</head><body>Owned compatibility fixture</body></html>'; }
const optionalLinks = [
  ['icon', './favicon.ico'],
  ['shortcut icon', './shortcut.ico'],
  ['apple-touch-icon', './logo192.png'],
  ['apple-touch-icon-precomposed', './precomposed.png'],
  ['mask-icon', './mask.svg'],
];

test('repository compatibility regressions', { timeout: 15000 }, async t => {
  await prepare();
  console.log(JSON.stringify({ fixture, role: 'Owned compatibility fixture group; no runtime/state resets', owner: groupOwner }));
  await t.test('GPL v3 remains GPL when its body mentions GNU Affero; the actual AGPL title is AGPL', { timeout: 2000 }, () => {
    write('gpl', 'LICENSE', 'GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007\n\nCopyright fixture\n\n13. Use with the GNU Affero General Public License.\nYou may link covered works with a work licensed under the GNU Affero General Public License.\n');
    write('agpl', 'LICENSE', 'GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3, 19 November 2007\n\nCopyright fixture\n\nThis is the actual Affero license title, not a cross-reference in another license.\n');
    assert.equal(readProvenance(path.join(fixture, 'gpl')).provenance.license, 'GPL-3.0');
    assert.equal(readProvenance(path.join(fixture, 'agpl')).provenance.license, 'AGPL-3.0');
  });
  await t.test('only absent optional icon links are reported and removed from the served document', { timeout: 2000 }, () => {
    const source = path.join(fixture, 'optional');
    write('optional', 'game.css', 'body { color: #333; }\n');
    write('optional', 'app.js', 'window.compatibilityFixtureLoaded = true;\n');
    const upstreamPath = write('optional', 'index.html', html(optionalLinks.map(([rel, href]) => '<link rel="' + rel + '" href="' + href + '">').join('') + '<link rel="stylesheet" href="./game.css"><script src="./app.js"></script>'));
    const before = fs.readFileSync(upstreamPath);
    const policy = validateWebOutput(source, '');
    assert.ok(Array.isArray(policy.missingOptional));
    assert.deepEqual([...policy.missingOptional].sort(), optionalLinks.map(([, href]) => href).sort());
    const served = localGameHtml(before.toString('utf8'), 'http://127.0.0.1', { missingOptional: policy.missingOptional });
    for (const [, href] of optionalLinks) assert.equal(served.html.includes('href="' + href + '"'), false, 'Absent icon must not be requested by the browser: ' + href);
    assert.match(served.html, /href="\.\/game\.css"/);
    assert.match(served.html, /src="\.\/app\.js"/);
    assert.deepEqual(fs.readFileSync(upstreamPath), before, 'Serving adaptation must preserve original upstream bytes');
    const unadapted = localGameHtml(before.toString('utf8'), 'http://127.0.0.1');
    assert.match(unadapted.html, /href="\.\/logo192\.png"/, 'Missing icons are removed only with the trusted validator result');
  });
  await t.test('missing stylesheet and script remain errors; manifest/preload/image do not inherit the icon exception', { timeout: 3000 }, () => {
    const missing = [
      ['missing-stylesheet', '<link rel="stylesheet" href="./missing.css">'],
      ['missing-script', '<script src="./missing.js"></script>'],
      ['missing-manifest', '<link rel="manifest" href="./missing.webmanifest">'],
      ['missing-preload', '<link rel="preload" href="./missing.png" as="image">'],
      ['missing-image', '<img src="./missing.png">'],
    ];
    for (const [name, markup] of missing) {
      write(name, 'index.html', html(markup));
      assert.throws(() => validateWebOutput(path.join(fixture, name), ''), 'Missing required resource must reject: ' + name);
    }
  });
  await t.test('local optional icons cannot use hidden, escaping or absolute local paths', { timeout: 3000 }, () => {
    const source = path.join(fixture, 'unsafe-icon');
    for (const href of ['./.private/icon.png', './%2eprivate/icon.png', '../outside.png', '%2e%2e/outside.png', '/absolute.png', 'C:/absolute.png', 'http://127.0.0.1/absolute.png']) {
      write('unsafe-icon', 'index.html', html('<link rel="apple-touch-icon" href="' + href + '">'));
      assert.throws(() => validateWebOutput(source, ''), 'Optional icon must keep strict path constraints: ' + href);
    }
  });
  await t.test('external HTTP(S) icons use the existing served resource isolation policy, not the local missing-icon exception', { timeout: 3000 }, () => {
    const source = path.join(fixture, 'unsafe-icon');
    for (const href of ['https://example.invalid/icon.png', '//example.invalid/icon.png']) {
      const upstream = write('unsafe-icon', 'index.html', html('<link rel="apple-touch-icon" href="' + href + '">'));
      const before = fs.readFileSync(upstream);
      const policy = validateWebOutput(source, '');
      assert.deepEqual(policy.missingOptional, []);
      assert.ok(policy.removedExternal.some(item => item.element === 'link' && item.host === 'example.invalid'));
      const served = localGameHtml(before.toString('utf8'), 'http://127.0.0.1', { missingOptional: policy.missingOptional });
      assert.equal(served.html.includes(href), false, 'Served HTML must not request an external icon');
      assert.deepEqual(fs.readFileSync(upstream), before, 'Original checkout bytes must remain intact');
    }
  });
  await t.test('a real hard-linked icon rejects and only this test link is unlinked', { timeout: 3000 }, () => {
    const source = path.join(fixture, 'hardlink');
    const original = write('hardlink', 'original.png', Buffer.from('owned hard-link fixture'));
    write('hardlink', 'index.html', html('<link rel="icon" href="./hardlinked.png">'));
    const linked = path.join(source, 'hardlinked.png');
    assert.equal(fs.existsSync(linked), false, 'Do not replace an existing hardlink target');
    const originalBytes = fs.readFileSync(original);
    let created = false;
    try {
      fs.linkSync(original, linked); created = true;
      assert.ok(fs.lstatSync(linked).nlink > 1, 'Use an actual native hard link, not a simulated stat');
      assert.throws(() => validateWebOutput(source, ''), 'Optional icon must not allow a hard-linked resource');
    } finally {
      if (created) fs.unlinkSync(linked);
    }
    assert.equal(fs.existsSync(linked), false);
    assert.deepEqual(fs.readFileSync(original), originalBytes, 'Preserve the owned original fixture');
    console.log(JSON.stringify({ original, unlinked: linked, role: 'Only this test-created native link was removed' }));
  });
});

