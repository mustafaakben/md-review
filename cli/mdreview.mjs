#!/usr/bin/env node
// mdreview — zero-dependency CLI for agents to work MD Review comment sidecars.
//
//   node mdreview.mjs list    <file.md> [--status draft|submitted|resolved] [--json]
//   node mdreview.mjs show    <file.md> <id>
//   node mdreview.mjs reply   <file.md> <id> "<text>" [--author Claude]
//   node mdreview.mjs resolve <file.md> <id> ["<closing reply>"] [--author Claude]
//   node mdreview.mjs reopen  <file.md> <id>
//
// Every write re-reads the sidecar, applies the change, and writes it back, so
// it never clobbers comments the viewer added in the meantime.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const bool = (name) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
};

const status = flag('status');
const author = flag('author', 'Claude');
const asJson = bool('json');
const [cmd, mdArg, id, text] = args;

function usage(code = 1) {
  console.error(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 9).join('\n').replace(/^\/\/ ?/gm, ''));
  process.exit(code);
}
if (!cmd || !mdArg) usage();

const md = path.resolve(mdArg.replace(/\.comments\.json$/, ''));
const side = md + '.comments.json';
const now = () => new Date().toISOString();
const newId = (p) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;

function read() {
  if (!fs.existsSync(side)) return { schemaVersion: 1, file: path.basename(md), comments: [] };
  const raw = fs.readFileSync(side, 'utf8').replace(/^﻿/, '');
  return raw.trim() ? JSON.parse(raw) : { schemaVersion: 1, file: path.basename(md), comments: [] };
}
function mutate(fn) {
  const data = read();
  fn(data);
  const tmp = `${side}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  try {
    fs.renameSync(tmp, side);
  } catch {
    fs.writeFileSync(side, JSON.stringify(data, null, 2) + '\n', 'utf8');
    fs.rmSync(tmp, { force: true });
  }
  return data;
}
function find(data, cid) {
  const c = (data.comments || []).find((x) => x.id === cid);
  if (!c) {
    console.error(`No comment with id ${cid}`);
    process.exit(2);
  }
  return c;
}
function describe(c) {
  const lines = c.anchor?.lineStart ? `L${c.anchor.lineStart}-${c.anchor.lineEnd}` : 'L?';
  let s = `[${c.id}] ${c.status.toUpperCase()} ${lines} ${c.author} ${c.createdAt}\n  quote: "${c.anchor?.quote}"\n  body:  ${c.body}`;
  for (const r of c.replies || []) s += `\n    ↳ ${r.author} (${r.createdAt}): ${r.body}`;
  return s;
}

switch (cmd) {
  case 'list': {
    const cs = (read().comments || []).filter((c) => !status || c.status === status);
    if (asJson) console.log(JSON.stringify(cs, null, 2));
    else console.log(cs.length ? cs.map(describe).join('\n\n') : '(no comments)');
    break;
  }
  case 'show':
    console.log(JSON.stringify(find(read(), id), null, 2));
    break;
  case 'reply':
    if (!text) usage();
    mutate((d) => find(d, id).replies.push({ id: newId('r'), author, createdAt: now(), body: text }));
    console.log(`Replied to ${id}`);
    break;
  case 'resolve':
    mutate((d) => {
      const c = find(d, id);
      if (text) c.replies.push({ id: newId('r'), author, createdAt: now(), body: text });
      c.status = 'resolved';
      c.resolvedAt = now();
    });
    console.log(`Resolved ${id}`);
    break;
  case 'reopen':
    mutate((d) => {
      const c = find(d, id);
      c.status = 'submitted';
      c.resolvedAt = null;
    });
    console.log(`Reopened ${id}`);
    break;
  default:
    usage();
}
