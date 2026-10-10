import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const batch = path.join(root, '.omni', 'tmp', 'windows-trial', 'repository-tests');
const runtime = path.join(batch, 'runtime');
const ownerPath = path.join(batch, 'fixture-owner.json');
const receiptPath = path.join(batch, 'receipt-network-policy.json');
const runName = 'network-policy';
const npmCli = process.env.HUB_NPM_CLI || path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const catalogPath = path.join(root, 'src', 'catalog.json');
const catalogBefore = fs.readFileSync(catalogPath);
const native = [];
const repositories = [];
const servers = [];
const linkChecks = [];
let port;

function inspectLinks(target) {
  const stat = fs.lstatSync(target);
  assert.equal(stat.isSymbolicLink(), false, `No fixture links: ${target}`);
  if (stat.isFile()) assert.equal(stat.nlink, 1, `No fixture hard links: ${target}`);
  if (stat.isDirectory()) for (const child of fs.readdirSync(target)) inspectLinks(path.join(target, child));
}

function prepareBatch() {
  for (let current = batch; ; current = path.dirname(current)) {
    if (fs.existsSync(current)) assert.equal(fs.lstatSync(current).isSymbolicLink(), false, `Linked ancestor: ${current}`);
    if (current === root) break;
    assert.ok(current.startsWith(root + path.sep));
  }
  if (fs.existsSync(batch)) {
    inspectLinks(batch);
    const contents = fs.readdirSync(batch);
    if (contents.length) {
      assert.ok(fs.existsSync(ownerPath), `Unknown existing batch: ${batch}`);
      assert.equal(JSON.parse(fs.readFileSync(ownerPath, 'utf8')).owner, 'anything-hub-repository-blackbox');
    }
  }
  fs.mkdirSync(batch, { recursive: true });
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(ownerPath, JSON.stringify({ owner: 'anything-hub-repository-blackbox', version: 1, batch, runtime }, null, 2));
  // Only these owned state files are reset; source clones/logs remain in the same batch.
  fs.writeFileSync(path.join(runtime, 'state.json'), '{}');
  fs.writeFileSync(path.join(runtime, 'catalog.json'), '[]');
}

function command(exe, args, { cwd = batch, env = {}, timeout = 30000, label = 'native' } = {}) {
  const stdoutPath = path.join(batch, `${runName}-${native.length}-${label}.stdout.log`);
  const stderrPath = path.join(batch, `${runName}-${native.length}-${label}.stderr.log`);
  return new Promise((resolve, reject) => {
    const stdout = fs.createWriteStream(stdoutPath);
    const stderr = fs.createWriteStream(stderrPath);
    const child = spawn(exe, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let result = '';
    let errors = '';
    let timedOut = false;
    const deadline = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeout);
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    child.stdout.on('data', chunk => { result += chunk; });
    child.stderr.on('data', chunk => { errors += chunk; });
    child.once('error', error => { clearTimeout(deadline); stdout.end(); stderr.end(); reject(error); });
    child.once('close', code => {
      clearTimeout(deadline);
      native.push({ exe, args, cwd, exitCode: code, timedOut, stdoutPath, stderrPath });
      if (code === 0 && !timedOut) resolve(result.trim());
      else reject(new Error(`${label}: exit ${code}, timedOut=${timedOut}; ${errors}; logs ${stdoutPath}, ${stderrPath}`));
    });
  });
}

async function repository(name, files, host = 'github.com') {
  const work = path.join(batch, 'fixtures', name, 'work');
  const bare = path.join(batch, 'fixtures', name, 'origin.git');
  const url = `https://${host}/anything-hub-blackbox/${name}.git`;
  if (!fs.existsSync(path.join(work, '.git'))) {
    fs.mkdirSync(work, { recursive: true });
    for (const [relative, text] of Object.entries(files)) {
      const target = path.join(work, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    }
    await command('git', ['init', '--initial-branch=main', work], { label: `${name}-init` });
    await command('git', ['-C', work, 'add', '--all'], { label: `${name}-add` });
    await command('git', ['-C', work, '-c', 'user.name=AnythingHub Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Isolated black-box fixture'], { label: `${name}-commit` });
    await command('git', ['init', '--bare', '--initial-branch=main', bare], { label: `${name}-bare` });
    // Push transfers native Git objects and creates no filesystem links.
    await command('git', ['-C', work, 'push', bare, 'main'], { label: `${name}-push` });
  }
  inspectLinks(work);
  inspectLinks(bare);
  const commit = await command('git', ['-C', bare, 'rev-parse', 'HEAD'], { label: `${name}-head` });
  assert.match(commit, /^[0-9a-f]{40}$/);
  const item = { name, work, bare, url, commit, files: Object.keys(files).map(file => path.join(work, file)) };
  repositories.push(item);
  return item;
}

async function randomPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const chosen = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  assert.ok(![42100, 42110].includes(chosen));
  return chosen;
}

function request(route, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }));
      res.on('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error(`HTTP timeout: ${method} ${route}`)));
    req.once('error', reject);
    req.end(payload);
  });
}

async function startServer() {
  port = await randomPort();
  const index = servers.length;
  const stdoutPath = path.join(batch, `${runName}-server-${index}.stdout.log`);
  const stderrPath = path.join(batch, `${runName}-server-${index}.stderr.log`);
  const env = { ...process.env, HUB_HOME: runtime, HUB_PROJECT_ROOT: root, HUB_PORT: String(port), HUB_NPM_CLI: npmCli, GIT_CONFIG_COUNT: String(repositories.length), GIT_TERMINAL_PROMPT: '0', npm_config_offline: 'true' };
  repositories.forEach((repo, i) => {
    env[`GIT_CONFIG_KEY_${i}`] = `url.${pathToFileURL(repo.bare).href}.insteadOf`;
    env[`GIT_CONFIG_VALUE_${i}`] = repo.url;
  });
  const stdout = fs.createWriteStream(stdoutPath);
  const stderr = fs.createWriteStream(stderrPath);
  const child = spawn(process.execPath, [path.join(root, 'src', 'server.mjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  const instance = { child, pid: child.pid, port, stdoutPath, stderrPath, stopped: false };
  servers.push(instance);
  await new Promise((resolve, reject) => {
    let lines = '';
    let errors = '';
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      child.off('exit', exited);
      error ? reject(error) : resolve();
    };
    const deadline = setTimeout(() => finish(new Error(`Server readiness exceeded 15s; ${stderrPath}; ${errors}`)), 15000);
    const exited = code => finish(new Error(`Server exited before readiness: ${code}; ${errors}`));
    child.once('error', finish);
    child.once('exit', exited);
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-10000); });
    child.stdout.on('data', chunk => {
      lines += chunk;
      const complete = lines.split(/\r?\n/);
      lines = complete.pop();
      for (const line of complete) {
        try {
          const receipt = JSON.parse(line);
          if (receipt.ready) {
            assert.equal(path.resolve(receipt.runtime), runtime);
            assert.equal(receipt.pid, child.pid);
            instance.ready = receipt;
            finish();
          }
        } catch (error) { if (error instanceof assert.AssertionError) finish(error); }
      }
    });
  });
  return instance;
}

async function stopServer(instance) {
  const child = instance.child;
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise(resolve => {
      const deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('close', () => { clearTimeout(deadline); resolve(); });
      child.kill('SIGTERM');
    });
  }
  instance.stopped = true;
  instance.exitCode = child.exitCode;
  instance.signal = child.signalCode;
}

function installation(gameId) {
  // Real SSE stream supplies both current state and subsequent transitions: no model polling.
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const finish = (error, game) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      req.destroy();
      error ? reject(error) : resolve(game);
    };
    const req = http.get({ hostname: '127.0.0.1', port, path: '/api/events' }, res => {
      assert.equal(res.statusCode, 200);
      res.setEncoding('utf8');
      res.on('data', chunk => {
        buffer += chunk;
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop();
        for (const frame of frames) for (const line of frame.split(/\r?\n/)) {
          if (!line.startsWith('data: ')) continue;
          const event = JSON.parse(line.slice(6));
          const game = event.games?.find(item => item.id === gameId);
          if (game && ['ready', 'failed'].includes(game.status)) finish(null, game);
        }
      });
      res.once('error', error => { if (!settled) finish(error); });
      res.once('end', () => { if (!settled) finish(new Error(`SSE ended before an installation terminal state: ${gameId}`)); });
    });
    req.once('error', error => { if (!settled) finish(error); });
    const deadline = setTimeout(() => finish(new Error(`Installation did not finish in 90s: ${gameId}; logs: ${path.join(runtime, 'logs')}`)), 90000);
  });
}

async function importGame(repo, extra = {}) {
  const response = await request('/api/catalog/import', { method: 'POST', body: { repo: repo.url, ...extra } });
  assert.equal(response.status, 202, response.text);
  const result = response.json();
  assert.match(result.gameId, /^[a-z0-9-]+$/);
  assert.ok(result.task?.id, response.text);
  return { result, game: await installation(result.gameId) };
}

async function verifyGit(repo, game) {
  const source = path.join(runtime, 'games', game.id, 'source');
  inspectLinks(source);
  const commit = await command('git', ['-C', source, 'rev-parse', 'HEAD'], { label: `${repo.name}-installed-head` });
  const origin = await command('git', ['-C', source, 'remote', 'get-url', 'origin'], { label: `${repo.name}-installed-origin` });
  assert.equal(commit, repo.commit);
  assert.equal(game.commit, repo.commit);
  assert.equal(origin, repo.url);
  return source;
}

test('unknown public repositories are installed, built and persisted without editing curated metadata', { timeout: 180000 }, async t => {
  prepareBatch();
  let failure = null;
  t.after(async () => {
    for (const server of servers) await stopServer(server);
    inspectLinks(batch);
    assert.deepEqual(fs.readFileSync(catalogPath), catalogBefore, 'Curated source catalog must remain unchanged');
    const receipt = { test: 'anything-hub-repository-blackbox', failure, batch, runtime, ownerPath, receiptPath, repositories, servers: servers.map(({ child, ...rest }) => rest), native, linkChecks, networkScope: 'Public HTTPS repository URL policy is tested using child-process-only rewrites to owned local bare Git repositories; this is not a live provider network test.', cleanup: 'Owned server processes closed in native finally; temporary resource link objects removed; all repository fixtures retained in the fixed batch.' };
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
    console.log(`Native receipt: ${receiptPath}`);
  });
  try {
    assert.ok(fs.existsSync(npmCli), `Missing npm CLI: ${npmCli}`);
    const mitLicense = `MIT License

Copyright (c) 2026 Fixture

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
`;
    const staticRepo = await repository('unknown-static', { 'index.html': '<!doctype html><title>Unknown static fixture</title><p id="unknown-static">Fresh static game</p>', LICENSE: mitLicense });
    const pkg = { name: 'unknown-npm-game', version: '1.0.0', private: true, type: 'module', scripts: { build: 'node generate.mjs' } };
    const buildRepo = await repository('unknown-npm-lockbuild', {
      'package.json': JSON.stringify(pkg, null, 2),
      'package-lock.json': JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { '': { name: pkg.name, version: pkg.version } } }, null, 2),
      'generate.mjs': "import fs from 'node:fs'; fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/index.html','<!doctype html><title>Generated fixture</title><p id=unknown-built>Native npm build generated this page</p>'); console.log('FIXTURE_NATIVE_NPM_BUILD');\n"
    }, 'codeberg.org');
    const noEntry = await repository('unknown-no-entry', { 'README.md': '# No runnable entry fixture\n' }, 'gitlab.com');
    const outputRepo = await repository('unknown-static-output', { 'public/index.html': '<!doctype html><title>Subdirectory fixture</title><p>Safe explicit output directory</p>', LICENSE: mitLicense }, 'gitee.com');
    const trackerRepo = await repository('unknown-external-tracker', { 'index.html': '<!doctype html><title>Tracker fixture</title><script async data-goatcounter="https://fixture.goatcounter.com/count" src="https://gc.zgo.at/count.js"></script><p>Tracker-free served fixture</p>' });
    const absoluteRepo = await repository('unknown-absolute-resource', { 'index.html': '<!doctype html><title>Absolute resource fixture</title><img src="/asset.png"><p>Absolute local resource must fail</p>', 'asset.png': 'Owned fixture resource' });
    await startServer();
    let staticGame;
    let buildGame;
    let outputGame;
    await t.test('unknown static repository imports and serves real HTML with native origin/HEAD and detected MIT', async () => {
      const initial = (await request('/api/catalog')).json().games;
      assert.ok(initial.some(game => game.id === '2048'), 'Curated games remain merged');
      assert.equal(initial.some(game => game.repo === staticRepo.url), false);
      const imported = await importGame(staticRepo, { title: 'Unknown static fixture', ref: 'main' });
      staticGame = imported.game;
      assert.equal(staticGame.status, 'ready', JSON.stringify(staticGame));
      assert.equal(staticGame.mode, 'static');
      assert.equal(staticGame.license, 'MIT');
      await verifyGit(staticRepo, staticGame);
      const page = await request(`/games/${staticGame.id}/index.html`);
      assert.equal(page.status, 200, page.text);
      assert.match(page.text, /Fresh static game/);
    });
    await t.test('an allowed Gitee repository serves a safely specified static output directory', async () => {
      const imported = await importGame(outputRepo, { output: 'public' });
      outputGame = imported.game;
      assert.equal(outputGame.status, 'ready', JSON.stringify(outputGame));
      assert.equal(outputGame.mode, 'static');
      assert.equal(outputGame.output, 'public');
      await verifyGit(outputRepo, outputGame);
      const page = await request(`/games/${outputGame.id}/index.html`);
      assert.equal(page.status, 200, page.text);
      assert.match(page.text, /Safe explicit output directory/);
    });
    await t.test('unknown lockfile repository runs native npm ci/build and serves generated output without network dependencies', async () => {
      const imported = await importGame(buildRepo);
      buildGame = imported.game;
      assert.equal(buildGame.status, 'ready', JSON.stringify(buildGame));
      assert.equal(buildGame.mode, 'build');
      assert.equal(buildGame.output, 'dist');
      assert.match(String(buildGame.license), /未声明|undeclared/i);
      const source = await verifyGit(buildRepo, buildGame);
      assert.ok(fs.existsSync(path.join(source, 'dist', 'index.html')));
      const page = await request(`/games/${buildGame.id}/index.html`);
      assert.equal(page.status, 200, page.text);
      assert.match(page.text, /Native npm build generated this page/);
      const log = await request(`/api/games/${buildGame.id}/log.txt`);
      assert.equal(log.status, 200);
      assert.match(log.text, /FIXTURE_NATIVE_NPM_BUILD/);
      assert.match(log.text, /npm|构建|build/);
    });
    await t.test('external automatic tracker is removed from served HTML while the original checkout and native HEAD stay intact', async () => {
      const imported = await importGame(trackerRepo);
      assert.equal(imported.game.status, 'ready', JSON.stringify(imported.game));
      assert.ok(imported.game.compatibility.removedExternal.some(item => item.element === 'script' && item.host === 'gc.zgo.at'));
      const source = await verifyGit(trackerRepo, imported.game);
      const originalPath = path.join(source, 'index.html');
      const original = fs.readFileSync(originalPath);
      assert.match(original.toString(), /gc\.zgo\.at\/count\.js/);
      const page = await request(`/games/${imported.game.id}/index.html`);
      assert.equal(page.status, 200, page.text);
      assert.match(page.text, /Tracker-free served fixture/);
      assert.doesNotMatch(page.text, /gc\.zgo\.at|goatcounter/);
      assert.deepEqual(fs.readFileSync(originalPath), original);
      assert.equal(await command('git', ['-C', source, 'status', '--porcelain'], { label: 'tracker-checkout-status' }), '');
    });
    await t.test('a local absolute resource remains an explicit installation failure', async () => {
      const imported = await importGame(absoluteRepo);
      assert.equal(imported.game.status, 'failed', JSON.stringify(imported.game));
      assert.match(imported.game.error, /相对|本地地址|绝对|relative|absolute/i);
      assert.equal((await request(`/games/${imported.game.id}/index.html`)).status, 409);
      await verifyGit(absoluteRepo, imported.game);
    });
    for (const kind of ['hardlink', 'symlink']) await t.test(`native ${kind} game resources are refused when supported by this machine`, async linkTest => {
      assert.ok(staticGame && staticGame.status === 'ready');
      const source = path.join(runtime, 'games', staticGame.id, 'source');
      const target = path.join(source, `${runName}-${kind}-target.txt`);
      const link = path.join(source, `${runName}-${kind}-resource.txt`);
      assert.equal(fs.existsSync(target), false, `Unexpected pre-existing link target: ${target}`);
      assert.equal(fs.existsSync(link), false, `Unexpected pre-existing link object: ${link}`);
      fs.writeFileSync(target, 'Owned resource-link refusal sentinel');
      let created = false;
      try {
        try {
          if (kind === 'hardlink') fs.linkSync(target, link);
          else fs.symlinkSync(target, link, 'file');
          created = true;
        } catch (error) {
          if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error;
          const reason = `${kind} unavailable to the native test process: ${error.code}`;
          linkChecks.push({ kind, target, link, skipped: true, reason });
          linkTest.skip(reason);
          return;
        }
        const response = await request(`/games/${staticGame.id}/${path.basename(link)}`);
        assert.equal(response.status, 403, response.text);
        assert.doesNotMatch(response.text, /Owned resource-link refusal sentinel/);
        linkChecks.push({ kind, target, link, skipped: false, status: response.status, removed: true });
      } finally {
        // Unlink only the exact temporary objects created above; never follow either link.
        if (created) fs.unlinkSync(link);
        fs.unlinkSync(target);
      }
    });
    await t.test('dynamic imports survive an actual server stop/restart and source catalog stays untouched', async () => {
      assert.ok(staticGame && buildGame && outputGame, 'All previous imports must succeed');
      const persisted = JSON.parse(fs.readFileSync(path.join(runtime, 'catalog.json'), 'utf8'));
      assert.ok(JSON.stringify(persisted).includes(staticRepo.url));
      assert.ok(JSON.stringify(persisted).includes(buildRepo.url));
      await stopServer(servers.at(-1));
      await startServer();
      const games = (await request('/api/catalog')).json().games;
      for (const prior of [staticGame, buildGame, outputGame]) {
        const current = games.find(game => game.id === prior.id);
        assert.equal(current.status, 'ready');
        assert.equal(current.commit, prior.commit);
        assert.equal((await request(`/anything-hub/games/${current.id}/index.html`)).status, 200);
      }
      assert.deepEqual(fs.readFileSync(catalogPath), catalogBefore);
    });
    await t.test('repository without an entry fails explicitly and can produce a diagnostic report', async () => {
      const imported = await importGame(noEntry);
      assert.equal(imported.game.status, 'failed');
      assert.ok(imported.game.error, 'Failure must explain missing entry');
      assert.match(imported.game.error, /index\.html|入口|entry|构建|build/i);
      assert.equal((await request(`/games/${imported.game.id}/index.html`)).status, 409);
      const report = await request('/api/reports', { method: 'POST', body: { gameId: imported.game.id, summary: 'No entry black-box fixture' } });
      assert.equal(report.status, 201, report.text);
      const saved = await request('/' + report.json().report.downloadUrl);
      assert.equal(saved.status, 200);
      assert.equal(saved.json().install.status, 'failed');
      assert.ok(saved.json().install.error);
      await verifyGit(noEntry, imported.game);
    });
    await t.test('unsafe output, URL and ref inputs are rejected before adding dynamic entries', async () => {
      const inputs = [
        { repo: staticRepo.url, output: '../escape' }, { repo: staticRepo.url, output: '..\\escape' },
        { repo: staticRepo.url, output: '/absolute' }, { repo: staticRepo.url, output: 'C:\\absolute' },
        { repo: staticRepo.url, output: '\\\\server\\share' },
        { repo: 'file://' + staticRepo.bare }, { repo: staticRepo.bare }, { repo: 'http://github.com/a/b.git' },
        { repo: 'https://invalid.example/a/b.git' }, { repo: 'https://user:password@github.com/a/b.git' },
        { repo: 'https://github.com/a/b.git?x=1' }, { repo: 'https://github.com/a/b.git#main' },
        { repo: staticRepo.url, ref: '--upload-pack=evil' }, { repo: staticRepo.url, ref: '../main' },
        { repo: staticRepo.url, ref: 'main\nother' }, { repo: staticRepo.url, ref: 'main;echo injected' }
      ];
      const before = fs.readFileSync(path.join(runtime, 'catalog.json'), 'utf8');
      for (const input of inputs) {
        const response = await request('/api/catalog/import', { method: 'POST', body: input });
        assert.equal(response.status, 400, `${JSON.stringify(input)}: ${response.status} ${response.text}`);
        assert.ok(response.json().error);
      }
      assert.equal(fs.readFileSync(path.join(runtime, 'catalog.json'), 'utf8'), before);
    });
  } catch (error) {
    failure = { name: error.name, message: error.message };
    throw error;
  }
});
