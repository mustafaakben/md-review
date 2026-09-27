// Smoke test in a real VS Code: `npm run test:smoke`. Downloads VS Code into
// .vscode-test/ on first use (about 150 MB; VSCODE_VERSION picks a version,
// default stable). On Linux without a display, run it under xvfb-run.
import { runTests } from '@vscode/test-electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-smoke-'));
fs.writeFileSync(path.join(work, 'doc.md'), '# Title\n\nA bold claim here.\n\nSecond para.\n');
fs.mkdirSync(path.join(work, '.vscode'));
fs.writeFileSync(path.join(work, '.vscode', 'settings.json'), JSON.stringify({}));
// VS Code's IPC socket lives in the user data folder, and its path must stay under
// about 103 characters: the default (.vscode-test/ in the repo) is too long in a deep checkout.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mdr-ud-'));

try {
  await runTests({
    version: process.env.VSCODE_VERSION || 'stable',
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(here, 'suite.cjs'),
    extensionTestsEnv: { MDR_SMOKE_DIR: work },
    launchArgs: [work, '--user-data-dir', userData, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'],
  });
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
  fs.rmSync(userData, { recursive: true, force: true });
}
