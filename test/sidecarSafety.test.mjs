import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readText, mutateSidecar } = require('../cli/sidecar-io.cjs');
const modulePath = require.resolve('../cli/sidecar-io.cjs');
const fresh = t => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdreview-safety-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return path.join(dir, 'doc.md.comments.json'); };
const error = code => Object.assign(new Error(code), { code });

test('only missing sidecars are treated as empty; read failures preserve the file', t => {
  const file = fresh(t);
  assert.equal(readText(file), null);
  fs.writeFileSync(file, '{"comments":[{"id":"original"}]}');
  const io = { ...fs, readFileSync: (p, ...args) => { if (p === file) throw error('EACCES'); return fs.readFileSync(p, ...args); } };
  assert.throws(() => mutateSidecar(file, () => ({ comments: [] }), { io }), /EACCES/);
  assert.equal(JSON.parse(fs.readFileSync(file)).comments[0].id, 'original');
  assert.equal(fs.existsSync(file + '.lock'), false);
});
test('temporary rename failures retry atomically; permanent failures never truncate the original', t => {
  const file = fresh(t); fs.writeFileSync(file, '{"n":1}');
  let attempts = 0;
  const io = { ...fs, renameSync: (...args) => { if (++attempts < 3) throw error('EBUSY'); fs.renameSync(...args); } };
  mutateSidecar(file, () => ({ n: 2 }), { io });
  assert.equal(attempts, 3);
  assert.equal(JSON.parse(fs.readFileSync(file)).n, 2);
  assert.throws(() => mutateSidecar(file, () => ({ n: 3 }), { io: { ...fs, renameSync: () => { throw error('EACCES'); } } }), /EACCES/);
  assert.equal(JSON.parse(fs.readFileSync(file)).n, 2);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), [path.basename(file)]);
});
test('a competing external revision is merged before committing', t => {
  const file = fresh(t); fs.writeFileSync(file, '{"comments":[],"external":false}');
  let injected = false;
  const io = { ...fs, writeFileSync: (p, ...args) => {
    fs.writeFileSync(p, ...args);
    if (p.includes('.tmp-') && !injected) { injected = true; fs.writeFileSync(file, '{"comments":["other"],"external":true}'); }
  } };
  mutateSidecar(file, raw => { const d = JSON.parse(raw); d.comments.push('ours'); return d; }, { io });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { comments: ['other', 'ours'], external: true });
});
test('empty and corrupt existing sidecars are not replaced by mutations', t => {
  const file = fresh(t);
  for (const text of ['', '{broken']) {
    fs.writeFileSync(file, text);
    assert.throws(() => mutateSidecar(file, raw => JSON.parse(raw)));
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});
test('a briefly busy lock file (sync client) is still released', t => {
  const file = fresh(t);
  let failures = 0;
  const io = { ...fs, unlinkSync: p => { if (p.endsWith('.lock') && failures++ < 3) throw error('EPERM'); fs.unlinkSync(p); } };
  mutateSidecar(file, () => ({ n: 1 }), { io });
  assert.equal(fs.existsSync(file + '.lock'), false);
});
test('a lock that cannot be released never fails the save that succeeded', t => {
  const file = fresh(t);
  const io = { ...fs, unlinkSync: p => { if (p.endsWith('.lock')) throw error('EPERM'); fs.unlinkSync(p); } };
  assert.deepEqual(mutateSidecar(file, () => ({ n: 1 }), { io }).data, { n: 1 });
  assert.equal(JSON.parse(fs.readFileSync(file)).n, 1);
});
test('a leaked local lock held by a live process is recovered once stale', t => {
  const file = fresh(t);
  fs.writeFileSync(file + '.lock', JSON.stringify({ pid: process.pid, host: os.hostname() }));
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(file + '.lock', old, old);
  mutateSidecar(file, () => ({ n: 1 }));
  assert.equal(JSON.parse(fs.readFileSync(file)).n, 1);
  assert.equal(fs.existsSync(file + '.lock'), false);
});
test('a fresh lock held by a live process is respected', t => {
  const file = fresh(t);
  fs.writeFileSync(file + '.lock', JSON.stringify({ pid: process.pid, host: os.hostname() }));
  assert.throws(() => mutateSidecar(file, () => ({ n: 1 })), /being updated by another process/);
  assert.equal(fs.existsSync(file), false);
});
test('simultaneous processes preserve every comment update', async t => {
  const file = fresh(t); fs.writeFileSync(file, '{"comments":[],"custom":"preserved"}');
  await Promise.all([0, 1, 2, 3].map(worker => new Promise((resolve, reject) => {
    const script = `const {mutateSidecar}=require(process.argv[1]); for(let i=0;i<8;i++) mutateSidecar(process.argv[2], raw=>{const d=JSON.parse(raw); d.comments.push(process.argv[3]+':'+i); return d;});`;
    const child = spawn(process.execPath, ['-e', script, modulePath, file, String(worker)]);
    let stderr = ''; child.stderr.on('data', s => stderr += s);
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
  })));
  const data = JSON.parse(fs.readFileSync(file));
  assert.equal(new Set(data.comments).size, 32); assert.equal(data.custom, 'preserved');
});
