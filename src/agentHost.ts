// The agent side of a review session, shared by VS Code and the browser
// harness: which session this document's messages go to, starting one, and
// delivering a prompt into it. Where the binding is kept and how a terminal
// is opened are the host's business.
import * as os from 'os';
import * as path from 'path';
import type { AgentHost, Delivery } from './core';
import { AgentKind, AgentSession, Binding, codexSessions, deliver, DeliveryError, findSession, listSessions, newSessionId } from './agentSessions';
import { findProgram, parseCommand } from './agentLaunch';

export interface AgentHostOptions {
  /** The folder sessions are listed for and started in (the workspace folder). */
  folder(): string;
  fileName: string;
  getBinding(): Binding | undefined;
  setBinding(b: Binding | undefined): void;
  getDelivery(): Delivery;
  setDelivery(d: Delivery): void;
  /** The command lines for each agent (settings), e.g. `claude --permission-mode acceptEdits`. */
  command(agent: AgentKind): string;
  /**
   * Run argv in a terminal of its own, in `cwd`. Returns false when it
   * couldn't (the host told the user). Absent in the browser, where
   * `handOver` gives the user the command to run instead.
   */
  openTerminal?(argv: string[], name: string, cwd: string): boolean;
  handOver?(commandLine: string): void;
  home?: string;
  /** How long to wait for a started session to show up (ms). */
  startTimeoutMs?: number;
  pollMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const label = (a: AgentKind) => (a === 'codex' ? 'Codex' : 'Claude');

/** A command line for display: arguments with spaces or quotes are quoted. */
function shown(argv: string[]): string {
  return argv.map((a) => (/^[\w./:=@+-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ');
}

export function createAgentHost(o: AgentHostOptions): AgentHost & { deliverPrompt(prompt: string): Promise<string | null> } {
  const home = o.home ?? os.homedir();
  const poll = o.pollMs ?? 1000;
  const timeout = o.startTimeoutMs ?? 120000;

  /** argv for an agent: the program (found where installers put it) and the setting's extra arguments. */
  function program(agent: AgentKind): string[] {
    const [prog = agent, ...extra] = parseCommand(o.command(agent) || agent, process.platform === 'win32');
    const exe = findProgram(prog, { platform: process.platform, env: process.env, home }) ?? prog;
    return [exe, ...extra];
  }

  function run(argv: string[], name: string): boolean {
    if (o.openTerminal) return o.openTerminal(argv, name, o.folder());
    const line = `cd ${shown([o.folder()])} && ${shown([path.basename(argv[0]), ...argv.slice(1)])}`;
    o.handOver?.(line);
    return true;
  }

  async function waitFor<T>(find: () => T | undefined): Promise<T | undefined> {
    for (const end = Date.now() + timeout; Date.now() < end; ) {
      const hit = find();
      if (hit) return hit;
      await sleep(poll);
    }
    return undefined;
  }

  const host = {
    list(): AgentSession[] {
      return listSessions(o.folder(), home);
    },
    binding: () => o.getBinding(),
    bind: (b: Binding | undefined) => o.setBinding(b),
    state: (b: Binding) => findSession(o.folder(), b, home),
    delivery: () => o.getDelivery(),
    setDelivery: (d: Delivery) => o.setDelivery(d),

    async start(agent: AgentKind, resume?: string): Promise<Binding | null> {
      const name = `MD Review · ${o.fileName}`;
      const title = `${label(agent)} · ${o.fileName}`;
      if (agent === 'claude') {
        // We choose the id, so the session is bound before it has even started.
        const id = resume ?? newSessionId();
        const argv = [...program('claude'), ...(resume ? ['--resume', id] : ['--session-id', id, '-n', name])];
        if (!run(argv, title)) return null;
        return { agent, id, name: resume ? undefined : name };
      }
      if (resume) {
        if (!run([...program('codex'), 'resume', resume], title)) return null;
        return { agent, id: resume };
      }
      // A Codex thread exists once it has had a turn: start with a short one, then find it.
      const since = Date.now() - 2000;
      const hello = `MD Review connected this session to ${o.fileName}. Review comments will arrive as messages; handle them when they do. For now, reply only: Ready.`;
      if (!run([...program('codex'), hello], title)) return null;
      const s = await waitFor(() => codexSessions(o.folder(), home, { days: 1, sinceMs: since })[0]);
      if (!s) throw new DeliveryError("Codex didn't start a session in time. Once it's running, pick it from the session menu.");
      return { agent, id: s.id, name: s.name };
    },

    /** runAgent: deliver the prompt into the bound session. */
    async deliverPrompt(prompt: string): Promise<string | null> {
      const b = o.getBinding();
      if (!b) return null;
      // A session just started (or resumed) takes a moment to open its inbox.
      if (b.agent === 'claude' && !findSession(o.folder(), b, home)?.live) {
        const up = await waitFor(() => {
          const s = findSession(o.folder(), b, home);
          return s?.live && s.socket ? s : undefined;
        });
        if (!up) throw new DeliveryError("That Claude session isn't running. Resume it or pick another session.");
      }
      const s = await deliver(b, prompt, { folder: o.folder(), codex: program('codex')[0], home });
      const who = s.name || b.name;
      return `Sent to ${label(b.agent)}${who ? ` · ${who}` : ''}.${s.status === 'busy' ? ' It will read it between steps.' : ''}`;
    },
  };
  return host;
}
