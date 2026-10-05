// Connect a workspace folder to MD Review for Claude Code: the md-review skill
// and CLI in .claude/skills/md-review/, and in .claude/settings.local.json
//   - SessionStart / SessionEnd hooks, so a session started here registers
//     itself with MD Review (~/.mdreview/sessions) and learns how review
//     comments reach it,
//   - a permission rule for the CLI, so working a comment needs no prompt,
//   - optionally crossSessionInbound: "accept", so messages from MD Review
//     aren't held for approval in sessions that skip permission prompts.
// settings.local.json is merged, never replaced: other keys and hooks stay.
// The CLI's init-claude does the same (cli/mdreview.mjs); keep them in step.
import * as fs from 'fs';
import * as path from 'path';

export const SKILL_DIR = path.join('.claude', 'skills', 'md-review');
export const CLI_RULE = 'Bash(node .claude/skills/md-review/mdreview.mjs:*)';
/** Markdown edits without a prompt (when the CLI's apply can't place a text and the agent edits itself)… */
export const EDIT_RULE = 'Edit(**/*.md)';
/** …but never the agent's own instructions or settings. Deny wins over allow. */
export const EDIT_DENY = ['Edit(**/CLAUDE.md)', 'Edit(**/AGENTS.md)', 'Edit(.claude/**)'];
const hookCommand = (event: string) => `node "$CLAUDE_PROJECT_DIR/.claude/skills/md-review/mdreview.mjs" hook ${event} --agent claude`;
const HOOK_MARK = 'mdreview.mjs" hook ';

export interface ConnectOptions {
  /** Where SKILL.md and mdreview.mjs ship (the extension's cli/ folder). */
  cliDir: string;
  /** Also let MD Review's messages in without approval (crossSessionInbound: accept). */
  acceptInbound?: boolean;
}

export interface ConnectPlan {
  skillExists: boolean;
  /** The installed SKILL.md differs from this version. */
  skillDiffers: boolean;
  /** What would change in settings.local.json, in words. */
  settings: string[];
  settingsPath: string;
}

function readSettings(file: string): Record<string, any> {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  const v = JSON.parse(text); // a broken file is an error: never overwrite what we can't read
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${file} isn't a JSON object.`);
  return v;
}

/** The settings with MD Review's hooks, rule and (optionally) inbound setting merged in. */
export function mergeSettings(s: Record<string, any>, acceptInbound = false): { settings: Record<string, any>; changes: string[] } {
  const out = JSON.parse(JSON.stringify(s || {}));
  const changes: string[] = [];
  out.hooks = out.hooks && typeof out.hooks === 'object' ? out.hooks : {};
  for (const [event, arg] of [['SessionStart', 'session-start'], ['SessionEnd', 'session-end']] as const) {
    const groups: any[] = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
    const ours = groups.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => typeof h?.command === 'string' && h.command.includes(HOOK_MARK)));
    if (!ours) {
      groups.push({ hooks: [{ type: 'command', command: hookCommand(arg), timeout: 10 }] });
      changes.push(`${event} hook`);
    }
    out.hooks[event] = groups;
  }
  out.permissions = out.permissions && typeof out.permissions === 'object' ? out.permissions : {};
  const allow: string[] = Array.isArray(out.permissions.allow) ? out.permissions.allow : [];
  if (!allow.includes(CLI_RULE)) {
    allow.push(CLI_RULE);
    changes.push('permission to run the MD Review CLI');
  }
  if (!allow.includes(EDIT_RULE)) {
    allow.push(EDIT_RULE);
    changes.push('permission to edit Markdown files (not CLAUDE.md, AGENTS.md or .claude/)');
  }
  out.permissions.allow = allow;
  const deny: string[] = Array.isArray(out.permissions.deny) ? out.permissions.deny : [];
  for (const r of EDIT_DENY) if (!deny.includes(r)) deny.push(r);
  out.permissions.deny = deny;
  if (acceptInbound && out.crossSessionInbound !== 'accept') {
    out.crossSessionInbound = 'accept';
    changes.push('crossSessionInbound: accept');
  }
  return { settings: out, changes };
}

export function planConnect(folder: string, o: ConnectOptions): ConnectPlan {
  const skill = path.join(folder, SKILL_DIR, 'SKILL.md');
  const skillExists = fs.existsSync(skill);
  const settingsPath = path.join(folder, '.claude', 'settings.local.json');
  return {
    skillExists,
    skillDiffers: skillExists && fs.readFileSync(skill, 'utf8') !== fs.readFileSync(path.join(o.cliDir, 'SKILL.md'), 'utf8'),
    settings: mergeSettings(readSettings(settingsPath), o.acceptInbound).changes,
    settingsPath,
  };
}

/** Install the skill and merge the settings. Returns what changed, in words. */
export function connectFolder(folder: string, o: ConnectOptions): string[] {
  const dest = path.join(folder, SKILL_DIR);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ['SKILL.md', 'mdreview.mjs', 'sidecar-io.cjs']) fs.copyFileSync(path.join(o.cliDir, f), path.join(dest, f));
  const file = path.join(folder, '.claude', 'settings.local.json');
  const { settings, changes } = mergeSettings(readSettings(file), o.acceptInbound);
  if (changes.length) {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
    fs.renameSync(tmp, file);
  }
  return ['the md-review skill and CLI', ...changes];
}
