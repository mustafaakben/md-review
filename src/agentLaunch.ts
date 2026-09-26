// Finding and starting the agent program for Send to Claude, the same way on
// Windows, macOS and Linux. No vscode dependency, so it can be tested alone.
import * as fs from 'fs';
import * as path from 'path';

/**
 * Split a command line into program and arguments. Quotes group words
 * ("C:\Program Files\claude.exe", '--flag value'); outside Windows a backslash
 * escapes the next character, as in a POSIX shell. On Windows backslashes are
 * path separators and stay as they are.
 */
export function parseCommand(line: string, windows: boolean): string[] {
  const out: string[] = [];
  let cur = '';
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && !windows && i + 1 < line.length && '"\\$`'.includes(line[i + 1])) cur += line[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      started = true;
    } else if (c === '\\' && !windows && i + 1 < line.length) {
      cur += line[++i];
      started = true;
    } else if (/\s/.test(c)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += c;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

export interface LookupEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
  /** True if `p` is a file that can be run (injectable for tests). */
  isProgram?(p: string): boolean;
}

function defaultIsProgram(p: string, windows: boolean): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    if (!windows) fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Where installers put Claude Code (and npm puts global bins) that a GUI-started
 * VS Code may not have on its PATH.
 */
function usualDirs({ platform, env, home }: LookupEnv): string[] {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const dirs = [p.join(home, '.local', 'bin'), p.join(home, '.claude', 'local'), p.join(home, '.npm-global', 'bin')];
  if (platform === 'win32') {
    if (env.APPDATA) dirs.push(p.join(env.APPDATA, 'npm'));
    if (env.LOCALAPPDATA) dirs.push(p.join(env.LOCALAPPDATA, 'Programs', 'claude'));
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', p.join(home, '.bun', 'bin'));
  }
  return dirs;
}

/**
 * Full path of `program`, looked up the way a shell would (PATH, and PATHEXT on
 * Windows) and then in the usual install locations. On Windows a real .exe is
 * preferred over a .cmd shim, which would run its arguments through cmd.exe.
 * Returns null when it can't be found.
 */
export function findProgram(program: string, look: LookupEnv): string | null {
  const windows = look.platform === 'win32';
  const p = windows ? path.win32 : path.posix;
  const isProgram = look.isProgram ?? ((f: string) => defaultIsProgram(f, windows));
  const pathVar = windows ? look.env.Path ?? look.env.PATH ?? '' : look.env.PATH ?? '';
  // Only what a terminal can start as a program (not .js or .vbs from PATHEXT).
  const exts = windows
    ? ['.exe', ...(look.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').map((e) => e.toLowerCase()).filter((e) => ['.com', '.bat', '.cmd'].includes(e))]
    : [''];
  // People type ~ in settings, and nothing expands it before us.
  if (/^~([\\/]|$)/.test(program)) program = p.join(look.home, program.slice(1));
  const hasExt = windows && /\.(com|exe|bat|cmd)$/i.test(program);
  const names = hasExt ? [program] : exts.map((e) => program + e);
  if (program.includes('/') || (windows && program.includes('\\'))) {
    return names.find(isProgram) ?? null;
  }
  const dirs = [...pathVar.split(windows ? ';' : ':').filter(Boolean).map((d) => d.replace(/^"(.*)"$/, '$1')), ...usualDirs(look)];
  for (const name of names) {
    for (const dir of dirs) {
      const full = p.join(dir, name);
      if (isProgram(full)) return full;
    }
  }
  return null;
}

/** Quote one argument for the shell a terminal runs, for typing it in there. */
export type ShellKind = 'posix' | 'fish' | 'pwsh' | 'cmd';

export function quoteFor(shell: ShellKind, arg: string): string {
  // A backslash escapes the next character in POSIX shells and fish.
  if (/^[\w./:-]+$/.test(arg) || (/^[\w./\\:-]+$/.test(arg) && (shell === 'pwsh' || shell === 'cmd'))) return arg;
  // PowerShell also takes curly single quotes as quotes; doubling escapes each.
  if (shell === 'pwsh') return `'${arg.replace(/['\u2018\u2019\u201a\u201b]/g, '$&$&')}'`;
  if (shell === 'cmd') return `"${arg.replace(/"/g, '""')}"`;
  // Inside fish's single quotes, \\ and \' are escapes.
  if (shell === 'fish') return `'${arg.replace(/[\\']/g, '\\$&')}'`;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** The shell kind of a terminal shell's path (VS Code's `env.shell`). */
export function shellKind(shellPath: string): ShellKind {
  const base = shellPath.split(/[\\/]/).pop()!.toLowerCase();
  if (/^(pwsh|powershell)(\.exe)?$/.test(base)) return 'pwsh';
  if (/^cmd(\.exe)?$/.test(base)) return 'cmd';
  if (/^fish(\.exe)?$/.test(base)) return 'fish';
  return 'posix';
}

/** A command line to type into a terminal running `shell`. */
export function commandLine(shell: ShellKind, argv: string[]): string {
  const line = argv.map((a) => quoteFor(shell, a)).join(' ');
  // PowerShell treats a quoted first word as a string, not a command.
  return shell === 'pwsh' && argv.length && line.startsWith("'") ? `& ${line}` : line;
}

/** Remove prompt files older than `maxAgeMs` from `dir`. Never throws. */
export function cleanOldPrompts(dir: string, maxAgeMs: number, now = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^review-prompt-.*\.md$/.test(name)) continue;
    const f = path.join(dir, name);
    try {
      if (now - fs.statSync(f).mtimeMs > maxAgeMs) fs.rmSync(f, { force: true });
    } catch {
      // Gone already, or locked on Windows: try again next time.
    }
  }
}
