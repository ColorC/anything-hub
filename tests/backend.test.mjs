import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(root, '.omni', 'tmp', 'windows-trial', 'backend');
const ownerFile = path.join(fixture, 'fixture-owner.json');
const port = 42110;
const base = `http://127.0.0.1:${port}`;
const fixtureCommit = 'fixture-authoritative-local-commit';
const allowed = new Set([
  'fixture-owner.json', 'state.json', 'games', 'games/2048', 'games/2048/source',
  'games/2048/source/index.html', 'games/2048/source/.git', 'games/2048/source/.git/config',
  'games/2048/private.txt', 'logs', 'logs/2048-install.log', 'logs/server-events.log', 'server.pid', 'reports'
]);
let ownedReports = [];

function rejectLinks(target) {
  const stat = fs.lstatSync(target);
  assert.equal(stat.isSymbolicLink(), false, `Fixture cannot use a symlink/junction: ${target}`);
  if (stat.isFile()) assert.ok(stat.nlink <= 1, `Fixture cannot use a hard link: ${target}`);
  return stat;
}

function recordOwnership() {
  fs.writeFileSync(ownerFile, JSON.stringify({ owner: 'anything-hub-backend-test', version: 1, reports: ownedReports }, null, 2));
}

function prepareFixture() {
  // Inspect existing ancestors and the entire fixture without following links before writing.
  for (let ancestor = fixture; ; ancestor = path.dirname(ancestor)) {
    if (fs.existsSync(ancestor)) rejectLinks(ancestor);
    if (ancestor === root) break;
    assert.ok(ancestor.startsWith(root + path.sep), `Fixture escaped the project: ${ancestor}`);
  }
  if (fs.existsSync(fixture)) {
    const inspect = (directory) => {
      for (const item of fs.readdirSync(directory)) {
        const absolute = path.join(directory, item);
        const stat = rejectLinks(absolute);
        if (stat.isDirectory()) inspect(absolute);
      }
    };
    inspect(fixture);
    const entries = fs.readdirSync(fixture);
    if (entries.length) {
      assert.ok(fs.existsSync(ownerFile), `Refusing unknown existing fixture content: ${fixture}`);
      const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
      assert.equal(owner.owner, 'anything-hub-backend-test', `Unknown fixture owner: ${ownerFile}`);
      assert.equal(owner.version, 1);
      assert.ok(Array.isArray(owner.reports));
      ownedReports = owner.reports;
      for (const id of ownedReports) {
        assert.match(id, /^\d+-[a-z0-9]+$/);
        allowed.add(`reports/${id}.json`);
        allowed.add(`reports/${id}.html`);
      }
      const checkOwned = (directory) => {
        for (const item of fs.readdirSync(directory)) {
          const absolute = path.join(directory, item);
          const relative = path.relative(fixture, absolute).split(path.sep).join('/');
          assert.ok(allowed.has(relative), `Refusing an unowned fixture path: ${absolute}`);
          if (fs.lstatSync(absolute).isDirectory()) checkOwned(absolute);
        }
      };
      checkOwned(fixture);
    }
  }
  fs.mkdirSync(fixture, { recursive: true });
  recordOwnership();
  for (const directory of ['games/2048/source/.git', 'logs', 'reports']) fs.mkdirSync(path.join(fixture, directory), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'games/2048/source/index.html'), '<!doctype html><title>Backend acceptance fixture</title><p id="fixture">Owned test game</p>');
  fs.writeFileSync(path.join(fixture, 'games/2048/source/.git/config'), 'FIXTURE_HIDDEN_GIT_SECRET');
  fs.writeFileSync(path.join(fixture, 'games/2048/private.txt'), 'FIXTURE_TRAVERSAL_SECRET');
  fs.writeFileSync(path.join(fixture, 'logs/2048-install.log'), 'Fixture build log: <build-result>available</build-result>\n');
  fs.writeFileSync(path.join(fixture, 'state.json'), JSON.stringify({ '2048': { status: 'ready', commit: fixtureCommit } }, null, 2));
  for (const [relative, role] of [
    ['fixture-owner.json', 'test ownership receipt'], ['state.json', 'isolated local installation state'],
    ['games/2048/source/index.html', 'owned runnable test page'], ['games/2048/source/.git/config', 'hidden-file protection sentinel'],
    ['games/2048/private.txt', 'traversal protection sentinel'], ['logs/2048-install.log', 'test installation log']
  ]) console.log(`${role}: ${path.join(fixture, relative)}`);
}

function request(route, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, headers: res.headers, json: () => JSON.parse(text) }));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error(`Request exceeded 5 seconds: ${method} ${route}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function startServer() {
  const child = spawn(process.execPath, [path.join(root, 'src/server.mjs')], { cwd: root, env: { ...process.env, HUB_HOME: fixture, HUB_PORT: String(port) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const ready = new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const deadline = setTimeout(() => reject(new Error(`Server startup exceeded 15 seconds. Fixture: ${fixture}\n${stderr}`)), 15000);
    const finish = (error, data) => {
      clearTimeout(deadline);
      child.off('error', failed);
      child.off('exit', exited);
      error ? reject(error) : resolve(data);
    };
    const failed = error => finish(error);
    const exited = code => finish(new Error(`Server exited before readiness (${code}): ${stderr}`));
    child.once('error', failed);
    child.once('exit', exited);
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10000); });
    child.stdout.on('data', chunk => {
      stdout = (stdout + chunk).slice(-10000);
      for (const line of stdout.split(/\r?\n/)) {
        try {
          const result = JSON.parse(line);
          if (result.ready) { assert.equal(path.resolve(result.runtime), fixture); finish(null, result); return; }
        } catch (error) { if (error instanceof assert.AssertionError) finish(error); }
      }
    });
  });
  return { child, ready };
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const deadline = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5000);
    child.once('exit', () => { clearTimeout(deadline); resolve(); });
    child.kill('SIGTERM');
  });
}

test('backend acceptance uses only its isolated local runtime', { timeout: 45000 }, async t => {
  prepareFixture();
  const { child, ready } = startServer();
  t.after(async () => { await stopServer(child); recordOwnership(); });
  await ready;
  console.log(`Fixture preserved: ${fixture}`);

  await t.test('catalog and subpath serve the same local installation', async () => {
    for (const prefix of ['', '/anything-hub']) {
      const health = await request(`${prefix}/api/health`);
      assert.equal(health.status, 200);
      assert.equal(path.resolve(health.json().runtime), fixture);
      const catalog = await request(`${prefix}/api/catalog`);
      assert.equal(catalog.status, 200);
      assert.equal(catalog.json().games.find(game => game.id === '2048').commit, fixtureCommit);
      const game = await request(`${prefix}/games/2048/index.html`);
      assert.equal(game.status, 200);
      assert.match(game.text, /Owned test game/);
      assert.equal((await request(`${prefix}/`)).status, 200);
    }
  });

  await t.test('unknown repository identities cannot start installations', async () => {
    const response = await request('/api/games/not-in-the-catalog/install', { method: 'POST', body: { repo: 'https://invalid.example/never-download.git' } });
    assert.equal(response.status, 404);
    assert.equal(fs.existsSync(path.join(fixture, 'games/not-in-the-catalog')), false);
    const catalog = (await request('/api/catalog')).json();
    assert.equal(catalog.games.some(game => game.id === 'not-in-the-catalog'), false);
  });

  await t.test('traversal and hidden git metadata cannot be served', async () => {
    for (const prefix of ['', '/anything-hub']) {
      for (const suffix of ['%2e%2e%2fprivate.txt', '%2e%2e%5cprivate.txt', '.git/config', '%2egit/config']) {
        const response = await request(`${prefix}/games/2048/${suffix}`);
        assert.equal(response.status, 403, `Path must be denied: ${prefix}/games/2048/${suffix}`);
        assert.doesNotMatch(response.text, /FIXTURE_(?:TRAVERSAL|HIDDEN_GIT)_SECRET/);
      }
    }
  });

  await t.test('cross-site report writes are refused before data is saved', async () => {
    const before = fs.readdirSync(path.join(fixture, 'reports')).sort();
    const response = await request('/anything-hub/api/reports', { method: 'POST', headers: { Origin: 'https://unrelated.example' }, body: { gameId: '2048', summary: 'Cross-site write must fail' } });
    assert.equal(response.status, 403);
    assert.deepEqual(fs.readdirSync(path.join(fixture, 'reports')).sort(), before);
  });

  await t.test('report is escaped, rereadable and tied to authoritative local state', async () => {
    const summary = '<script id="untrusted-summary">alert("summary")</script>';
    const details = '<img src=x onerror="alert(\'details\')">\nSecond line';
    const response = await request('/anything-hub/api/reports', { method: 'POST', headers: { Origin: base }, body: { gameId: '2048', summary, details, selector: '#fixture', commit: 'untrusted-submitted-commit', diagnostics: { errors: [{ message: '<script>diagnostic</script>' }] } } });
    assert.equal(response.status, 201);
    const report = response.json().report;
    assert.match(report.id, /^\d+-[a-z0-9]+$/);
    ownedReports.push(report.id);
    recordOwnership();
    console.log(`saved test report JSON: ${path.join(fixture, 'reports', `${report.id}.json`)}`);
    console.log(`saved test report HTML: ${path.join(fixture, 'reports', `${report.id}.html`)}`);
    const saved = await request(`/anything-hub/${report.downloadUrl}`);
    assert.equal(saved.status, 200);
    assert.equal(saved.json().summary, summary);
    assert.equal(saved.json().details, details);
    assert.equal(saved.json().commit, fixtureCommit);
    assert.match(saved.json().install.log, /Fixture build log/);
    const html = await request(`/anything-hub/${report.url}`);
    assert.equal(html.status, 200);
    assert.doesNotMatch(html.text, /<script id="untrusted-summary">|<img src=x onerror=/);
    assert.match(html.text, /&lt;script id=&quot;untrusted-summary&quot;&gt;/);
    assert.match(html.text, /&lt;img src=x onerror=/);
    assert.match(html.text, /&lt;script&gt;diagnostic&lt;\/script&gt;/);
    assert.doesNotMatch(html.text, /untrusted-submitted-commit/);
    const list = (await request('/anything-hub/api/reports')).json().reports;
    assert.ok(list.some(item => item.id === report.id && item.summary === summary));
  });
});
