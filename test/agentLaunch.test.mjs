// Finding and starting the agent program on Windows, macOS and Linux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const lib = require('../dist/lib.cjs');

test('command lines split on spaces, keep quoted words together', () => {
  assert.deepEqual(lib.parseCommand('claude --permission-mode acceptEdits', false), ['claude', '--permission-mode', 'acceptEdits']);
  assert.deepEqual(lib.parseCommand('"/Users/Jane Doe/.local/bin/claude" --model x', false), ['/Users/Jane Doe/.local/bin/claude', '--model', 'x']);
  assert.deepEqual(lib.parseCommand("claude --append-system-prompt 'be brief, please'", false), ['claude', '--append-system-prompt', 'be brief, please']);
  assert.deepEqual(lib.parseCommand('/opt/my\\ tools/claude', false), ['/opt/my tools/claude']);
  assert.deepEqual(lib.parseCommand('"C:\\Program Files\\Claude\\claude.exe" --x', true), ['C:\\Program Files\\Claude\\claude.exe', '--x']);
  assert.deepEqual(lib.parseCommand('C:\\tools\\claude.cmd', true), ['C:\\tools\\claude.cmd']);
  assert.deepEqual(lib.parseCommand('claude --prompt ""', false), ['claude', '--prompt', '']);
  assert.deepEqual(lib.parseCommand('   ', false), []);
});

const fake = (files) => (p) => files.includes(p);

test('Windows: PATH with PATHEXT, and a real .exe beats a .cmd shim', () => {
  const look = (files, env = {}) => ({
    platform: 'win32',
    home: 'C:\\Users\\Jo',
    env: { Path: 'C:\\npm;"C:\\Program Files\\Claude"', PATHEXT: '.COM;.EXE;.BAT;.CMD', APPDATA: 'C:\\Users\\Jo\\AppData\\Roaming', ...env },
    isProgram: fake(files),
  });
  assert.equal(lib.findProgram('claude', look(['C:\\npm\\claude.cmd'])), 'C:\\npm\\claude.cmd');
  assert.equal(lib.findProgram('claude', look(['C:\\npm\\claude.cmd', 'C:\\Program Files\\Claude\\claude.exe'])), 'C:\\Program Files\\Claude\\claude.exe');
  // Not on PATH yet (installed after VS Code started): the usual folders.
  assert.equal(lib.findProgram('claude', look(['C:\\Users\\Jo\\.local\\bin\\claude.exe'], { Path: '' })), 'C:\\Users\\Jo\\.local\\bin\\claude.exe');
  assert.equal(lib.findProgram('claude', look(['C:\\Users\\Jo\\AppData\\Roaming\\npm\\claude.cmd'], { Path: '' })), 'C:\\Users\\Jo\\AppData\\Roaming\\npm\\claude.cmd');
  assert.equal(lib.findProgram('C:\\tools\\claude', look(['C:\\tools\\claude.exe'])), 'C:\\tools\\claude.exe');
  assert.equal(lib.findProgram('claude.cmd', look(['C:\\npm\\claude.cmd'])), 'C:\\npm\\claude.cmd');
  assert.equal(lib.findProgram('claude', look([])), null);
});

test('macOS and Linux: PATH, then ~/.local/bin, ~/.claude/local and Homebrew', () => {
  const look = (files, PATH = '/usr/bin:/bin') => ({ platform: 'darwin', home: '/Users/jo', env: { PATH }, isProgram: fake(files) });
  assert.equal(lib.findProgram('claude', look(['/usr/bin/claude', '/Users/jo/.local/bin/claude'])), '/usr/bin/claude');
  assert.equal(lib.findProgram('claude', look(['/Users/jo/.local/bin/claude'])), '/Users/jo/.local/bin/claude');
  assert.equal(lib.findProgram('claude', look(['/Users/jo/.claude/local/claude'])), '/Users/jo/.claude/local/claude');
  assert.equal(lib.findProgram('claude', look(['/opt/homebrew/bin/claude'], '')), '/opt/homebrew/bin/claude');
  assert.equal(lib.findProgram('/opt/x/claude', look(['/opt/x/claude'])), '/opt/x/claude');
  assert.equal(lib.findProgram('./claude', look([])), null);
});

test('the real file check needs an executable file', { skip: process.platform === 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-find-'));
  fs.writeFileSync(path.join(dir, 'agent'), '#!/bin/sh\n');
  const look = { platform: process.platform, home: '/nonexistent', env: { PATH: dir } };
  assert.equal(lib.findProgram('agent', look), null, 'not executable yet');
  fs.chmodSync(path.join(dir, 'agent'), 0o755);
  assert.equal(lib.findProgram('agent', look), path.join(dir, 'agent'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a command line typed into bash, zsh, fish, PowerShell or cmd keeps each argument whole', () => {
  const argv = ['/Users/Jane Doe/bin/claude', "--say=it's", 'Read the file in /tmp/a b.md'];
  assert.equal(lib.commandLine('posix', argv), `'/Users/Jane Doe/bin/claude' '--say=it'\\''s' 'Read the file in /tmp/a b.md'`);
  assert.equal(lib.commandLine('pwsh', ['C:\\Program Files\\claude.exe', "it's"]), `& 'C:\\Program Files\\claude.exe' 'it''s'`);
  assert.equal(lib.commandLine('pwsh', ['claude', '-x']), 'claude -x');
  assert.equal(lib.commandLine('cmd', ['C:\\Program Files\\claude.exe', 'say "hi"']), `"C:\\Program Files\\claude.exe" "say ""hi"""`);
  assert.equal(lib.shellKind('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'pwsh');
  assert.equal(lib.shellKind('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'pwsh');
  assert.equal(lib.shellKind('C:\\Windows\\System32\\cmd.exe'), 'cmd');
  assert.equal(lib.shellKind('/bin/zsh'), 'posix');
  assert.equal(lib.shellKind('/opt/homebrew/bin/fish'), 'fish');
});

test('quoting: backslashes, fish, and curly quotes in PowerShell', () => {
  // A POSIX shell would eat the backslash; Windows paths keep theirs.
  assert.equal(lib.quoteFor('posix', 'a\\b'), `'a\\b'`);
  assert.equal(lib.quoteFor('cmd', 'C:\\x\\y.md'), 'C:\\x\\y.md');
  assert.equal(lib.quoteFor('pwsh', 'C:\\x\\y.md'), 'C:\\x\\y.md');
  // fish single quotes take \\ and \' as escapes.
  assert.equal(lib.quoteFor('fish', "it's a\\b"), `'it\\'s a\\\\b'`);
  // PowerShell treats \u2018 and \u2019 like ' and needs each doubled.
  assert.equal(lib.quoteFor('pwsh', 'x\u2019; calc; \u2018y'), `'x\u2019\u2019; calc; \u2018\u2018y'`);
});

test('a ~ in the agent command means the home folder', () => {
  const look = { platform: 'darwin', home: '/Users/jo', env: { PATH: '' }, isProgram: fake(['/Users/jo/tools/claude']) };
  assert.equal(lib.findProgram('~/tools/claude', look), '/Users/jo/tools/claude');
  const win = { platform: 'win32', home: 'C:\\Users\\Jo', env: { Path: '' }, isProgram: fake(['C:\\Users\\Jo\\bin\\claude.exe']) };
  assert.equal(lib.findProgram('~\\bin\\claude', win), 'C:\\Users\\Jo\\bin\\claude.exe');
});

test('Windows: PATHEXT script types that a terminal would hand to another program are skipped', () => {
  const look = { platform: 'win32', home: 'C:\\Users\\Jo', env: { Path: 'C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD;.VBS;.JS' }, isProgram: fake(['C:\\bin\\claude.js']) };
  assert.equal(lib.findProgram('claude', look), null);
});

test('old prompt files are cleaned up, recent ones and other files are kept', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-prompts-'));
  const old = path.join(dir, 'review-prompt-1-aa.md');
  const fresh = path.join(dir, 'review-prompt-2-bb.md');
  const other = path.join(dir, 'notes.md');
  for (const f of [old, fresh, other]) fs.writeFileSync(f, 'x');
  const twoDaysAgo = (Date.now() - 2 * 86400e3) / 1000;
  fs.utimesSync(old, twoDaysAgo, twoDaysAgo);
  fs.utimesSync(other, twoDaysAgo, twoDaysAgo);
  lib.cleanOldPrompts(dir, 86400e3);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['notes.md', 'review-prompt-2-bb.md']);
  lib.cleanOldPrompts(path.join(dir, 'missing'), 1); // no throw
  fs.rmSync(dir, { recursive: true, force: true });
});
