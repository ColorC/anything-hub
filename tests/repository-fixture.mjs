import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const owner = 'anything-hub-repository-blackbox';

function statIfPresent(target) {
  try { return fs.lstatSync(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

// Each test owns its subgroup. Only the common batch identity is initialized here.
export async function prepareRepositoryBatch(root, batch) {
  assert.equal(batch, path.join(root, '.omni', 'tmp', 'windows-trial', 'repository-tests'));
  for (let current = batch; ; current = path.dirname(current)) {
    const stat = statIfPresent(current);
    if (stat) {
      assert.equal(stat.isSymbolicLink(), false, 'Linked fixture ancestor: ' + current);
      assert.ok(stat.isDirectory(), 'Fixture ancestor must be a directory: ' + current);
    }
    if (current === root) break;
    assert.ok(current.startsWith(root + path.sep), 'Fixture stays in the canonical project batch');
  }
  fs.mkdirSync(batch, { recursive: true });
  const ownerPath = path.join(batch, 'fixture-owner.json');
  if (!statIfPresent(ownerPath) && fs.readdirSync(batch).length === 0) {
    try {
      fs.writeFileSync(ownerPath, JSON.stringify({ owner, version: 1, batch, runtime: path.join(batch, 'runtime') }, null, 2), { flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  // Another test may have won wx, or the black-box test may be publishing its owner.
  // A finite native wait handles the brief create/write window; unknown data is never adopted.
  const deadline = performance.now() + 1000;
  for (;;) {
    const stat = statIfPresent(ownerPath);
    if (stat) {
      assert.equal(stat.isSymbolicLink(), false, 'Do not follow a linked batch owner: ' + ownerPath);
      assert.ok(stat.isFile(), 'Batch owner must be a file: ' + ownerPath);
      assert.equal(stat.nlink, 1, 'Do not use a hard-linked batch owner: ' + ownerPath);
      let identity;
      try { identity = JSON.parse(fs.readFileSync(ownerPath, 'utf8').replace(/^\uFEFF/, '')); }
      catch (error) { if (!(error instanceof SyntaxError) || performance.now() >= deadline) throw error; }
      if (identity) {
        assert.equal(identity.owner, owner, 'Preserve unknown batch ownership');
        assert.equal(path.resolve(identity.batch), batch, 'Batch owner must identify this exact directory');
        return;
      }
    }
    assert.ok(performance.now() < deadline, 'Preserve unknown batch without a complete owner: ' + batch);
    await delay(10);
  }
}
