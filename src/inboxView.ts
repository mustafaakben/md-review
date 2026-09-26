// The MD Review tree in the Explorer: threads across the workspace, grouped by
// whose turn it is. Nothing is scanned until the view is first shown.
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { buildInbox, excludedBy, GROUPS, Inbox, InboxFile, InboxGroup, InboxThread, parseInboxSidecar, threadDescription, threadLabel } from './inbox';
import { isWorking } from '../webview/round';

const SIDECAR = '.comments.json';
const INCLUDE = '**/*.md.comments.json';
// Same rule as the CLI's folder walk; findFiles adds files.exclude on top.
const EXCLUDE = '{**/node_modules/**,**/.*/**}';
const CAP = 2000;

const ICONS: Record<InboxGroup, string> = { needsYou: 'comment-unresolved', triage: 'sparkle', waiting: 'watch', drafts: 'edit', resolved: 'check' };
const KINDS = new Map([
  ['question', { icon: 'question', words: 'question' }],
  ['praise', { icon: 'thumbsup', words: 'praise' }],
]);

type Node =
  | { kind: 'group'; group: InboxGroup; files: InboxFile[]; count: number }
  | { kind: 'file'; group: InboxGroup; file: InboxFile }
  | { kind: 'thread'; group: InboxGroup; mdPath: string; comment: InboxThread; key: string };

export class InboxView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  static readonly viewId = 'mdReview.inbox';

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<Node>;
  private readonly subs: vscode.Disposable[] = [];
  /** Each sidecar's threads by path, reused while mtime and size are unchanged. */
  private readonly cache = new Map<string, { mtime: number; size: number; threads: InboxThread[] | null }>();
  private inbox: Inbox | undefined;
  private scanning: Promise<void> | undefined;
  private started = false;
  private disposed = false;
  private capped = false;
  private timer: NodeJS.Timeout | undefined;
  /** When the pending update runs. */
  private due = 0;
  /** Fires when the next working claim goes stale, to move its thread back. */
  private expiry: NodeJS.Timeout | undefined;
  private dirty = new Set<string>();
  private full = false;
  private status: vscode.StatusBarItem | undefined;

  constructor() {
    this.view = vscode.window.createTreeView(InboxView.viewId, { treeDataProvider: this, showCollapseAll: true });
    this.subs.push(this.view, this.changed);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      if (!this.started && !this.disposed) this.start();
      await this.scanning;
      const inbox = this.inbox;
      if (!inbox) return [];
      return GROUPS.filter((g) => inbox.counts[g.id]).map((g) => ({ kind: 'group', group: g.id, files: inbox.groups[g.id], count: inbox.counts[g.id] }));
    }
    if (node.kind === 'group') return node.files.map((file) => ({ kind: 'file', group: node.group, file }));
    if (node.kind === 'file') {
      // A hand-edited file can repeat an id, and VS Code drops a tree whose item ids repeat.
      const seen = new Map<string, number>();
      return node.file.threads.map((comment) => {
        const n = seen.get(comment.id) ?? 0;
        seen.set(comment.id, n + 1);
        return { kind: 'thread', group: node.group, mdPath: node.file.mdPath, comment, key: n ? `${comment.id}\u0000${n}` : comment.id };
      });
    }
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const E = vscode.TreeItemCollapsibleState;
    if (node.kind === 'group') {
      const label = GROUPS.find((g) => g.id === node.group)!.label;
      const item = new vscode.TreeItem(label, node.group === 'resolved' ? E.Collapsed : E.Expanded);
      item.id = node.group;
      item.description = String(node.count);
      item.iconPath = new vscode.ThemeIcon(ICONS[node.group]);
      return item;
    }
    if (node.kind === 'file') {
      const uri = vscode.Uri.file(node.file.mdPath);
      const item = new vscode.TreeItem(uri, E.Expanded);
      item.id = `${node.group}/${node.file.mdPath}`;
      const dir = path.dirname(vscode.workspace.asRelativePath(uri));
      item.description = dir === '.' ? String(node.file.threads.length) : `${dir} · ${node.file.threads.length}`;
      item.iconPath = vscode.ThemeIcon.File;
      return item;
    }
    const c = node.comment;
    const label = threadLabel(c);
    const item = new vscode.TreeItem(label, E.None);
    item.id = `${node.group}/${node.mdPath}/${node.key}`;
    const description = threadDescription(c);
    item.description = description;
    const working = node.group === 'waiting' && isWorking(c);
    const sugg = node.group === 'needsYou' && !!c.suggested;
    const last = c.replies[c.replies.length - 1];
    const tip = [c.body];
    if (working) tip.push(`${c.workingBy || 'Claude'} is working on this.`);
    // Needs you: what Claude said last, so the tooltip shows what to answer.
    else if (node.group === 'needsYou' && last) tip.push(`${last.author}: ${last.body}`);
    if (sugg) tip.push('A suggested edit is waiting for you.');
    item.tooltip = tip.join('\n\n');
    const kind = KINDS.get(c.kind ?? '');
    item.iconPath = new vscode.ThemeIcon(working ? 'sync~spin' : sugg ? 'diff' : kind?.icon ?? 'comment');
    // Screen readers get what the icon shows.
    const state = working ? `${c.workingBy || 'Claude'} is working on it` : sugg ? 'suggested edit waiting' : kind?.words ?? 'comment';
    item.accessibilityInformation = { label: [label, state, ...description.split(' · ')].filter(Boolean).join(', ') };
    item.command = { command: 'mdReview.openThread', title: 'Open Thread', arguments: [node.mdPath, c.id] };
    return item;
  }

  /** Rescan the whole workspace (the view's Refresh action). */
  refresh(): void {
    if (this.disposed) return;
    if (!this.started) return this.start();
    this.full = true;
    this.schedule(0);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.expiry);
    this.subs.forEach((d) => d.dispose());
    this.status?.dispose();
  }

  /** First look at the view: scan, then keep up with changes. */
  private start(): void {
    this.started = true;
    // Uses VS Code's workspace watcher (no watcher of our own). An event reads
    // that one sidecar; only Refresh, a change of folders, and a folder with
    // reviewed files in it going away search again.
    const watcher = vscode.workspace.createFileSystemWatcher(INCLUDE);
    // Deleting, renaming or trashing a folder is one event, for the folder.
    const deletes = vscode.workspace.createFileSystemWatcher('**', true, true, false);
    const onEvent = (uri: vscode.Uri) => {
      if (!this.cache.has(uri.fsPath) && (this.cache.size >= CAP || !searched(uri))) return;
      this.dirty.add(uri.fsPath);
      this.schedule(this.delay());
    };
    this.subs.push(
      watcher,
      deletes,
      watcher.onDidChange(onEvent),
      watcher.onDidCreate(onEvent),
      watcher.onDidDelete(onEvent),
      deletes.onDidDelete((uri) => this.folderGone(uri)),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
    );
    this.scanning = this.scan(true);
  }

  /** Drop the threads under a folder that went away, and search again in case it moved. */
  private folderGone(uri: vscode.Uri): void {
    const under = uri.fsPath + path.sep;
    let hit = false;
    for (const p of this.cache.keys()) {
      if (!p.startsWith(under)) continue;
      this.cache.delete(p);
      hit = true;
    }
    if (!hit) return;
    this.full = true;
    this.schedule(this.delay());
  }

  /** A burst of writes (Claude replying in turn) settles into one update; less often while out of sight. */
  private delay(): number {
    return this.view.visible ? 300 : 2000;
  }

  private schedule(ms: number): void {
    if (this.disposed) return;
    // A pending update keeps its time (only a sooner one replaces it), so steady writes still show.
    if (this.timer && this.due <= Date.now() + ms) return;
    clearTimeout(this.timer);
    this.due = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const full = this.full;
      this.full = false;
      // Chain on a scan in flight so two never interleave, and never on a failed one.
      this.scanning = (this.scanning ?? Promise.resolve()).catch(() => {}).then(() => this.scan(full));
      void this.scanning.then(
        () => this.disposed || this.changed.fire(),
        () => {},
      );
    }, ms);
  }

  /** A full scan searches the workspace; otherwise only the sidecars events named are read. */
  private async scan(full: boolean): Promise<void> {
    try {
      let paths: string[];
      if (full || !this.inbox) {
        const found = await vscode.workspace.findFiles(INCLUDE, EXCLUDE, CAP + 1);
        this.capped = found.length > CAP;
        paths = await distinct(found.slice(0, CAP).map((u) => u.fsPath));
        const keep = new Set(paths);
        for (const p of this.cache.keys()) if (!keep.has(p)) this.cache.delete(p);
      } else paths = [...this.dirty];
      const dirty = this.dirty;
      this.dirty = new Set();
      await Promise.all(paths.map((p) => this.load(p, dirty.has(p))));
    } catch {
      // Search unavailable (no folder open, cancelled): show what we have.
    }
    if (this.disposed) return;
    try {
      this.regroup();
    } catch {
      // Keep the last list rather than stop updating; parseInboxSidecar gives grouping nothing to trip on.
    }
  }

  /** Group what the cache holds, and come back when a working claim goes stale. */
  private regroup(): void {
    if (this.disposed) return;
    this.inbox = buildInbox([...this.cache].map(([sidecar, e]) => ({ mdPath: sidecar.slice(0, -SIDECAR.length), threads: e.threads })));
    this.update();
    clearTimeout(this.expiry);
    if (this.inbox.expires !== null) {
      this.expiry = setTimeout(() => {
        this.regroup();
        this.changed.fire();
      }, this.inbox.expires + 50);
    }
  }

  /** Read a sidecar unless the cached copy has the same mtime and size. */
  private async load(sidecar: string, force: boolean): Promise<void> {
    const uri = vscode.Uri.file(sidecar);
    try {
      const st = await vscode.workspace.fs.stat(uri);
      const hit = this.cache.get(sidecar);
      if (!force && hit && hit.mtime === st.mtime && hit.size === st.size) return;
      const raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      this.cache.set(sidecar, { mtime: st.mtime, size: st.size, threads: parseInboxSidecar(raw) });
    } catch {
      this.cache.delete(sidecar); // deleted, or gone since the search
    }
  }

  private update(): void {
    if (this.disposed) return;
    const { needsYou, triage } = this.inbox!.counts;
    // Claude's drafts to triage are the reviewer's turn too.
    const n = needsYou + triage;
    const total = GROUPS.reduce((s, g) => s + this.inbox!.counts[g.id], 0);
    this.view.message = this.capped
      ? `Showing threads from the first ${CAP} reviewed files only.`
      : total
        ? undefined
        : 'No review threads in this workspace yet. Open a Markdown file in MD Review and comment on a selection.';
    this.view.badge = n ? { value: n, tooltip: `${n} thread${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you` } : undefined;
    if (!this.status) {
      this.status = vscode.window.createStatusBarItem('mdReview.inbox', vscode.StatusBarAlignment.Left, 0);
      this.status.name = 'MD Review Inbox';
      this.status.command = `${InboxView.viewId}.focus`;
    }
    this.status.text = `$(comment-discussion) ${n} need${n === 1 ? 's' : ''} you`;
    this.status.tooltip = `MD Review: ${[needsYou && `${needsYou} answered by Claude`, triage && `${triage} from Claude to triage`].filter(Boolean).join(', ')}`;
    if (n) this.status.show();
    else this.status.hide();
  }
}

/** Whether the search would list this sidecar: in a workspace folder, and not in node_modules, a dot-folder or files.exclude. */
function searched(uri: vscode.Uri): boolean {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) return false;
  const rel = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
  if (rel.split('/').slice(0, -1).some((s) => s === 'node_modules' || s.startsWith('.'))) return false;
  const exclude = vscode.workspace.getConfiguration('files', folder.uri).get<Record<string, unknown>>('exclude') ?? {};
  return !excludedBy(rel, Object.keys(exclude).filter((g) => exclude[g] === true));
}

/** One path per file: a folder linked in beside its target would list its threads twice. */
async function distinct(paths: string[]): Promise<string[]> {
  // Resolve each folder once; a link is nearly always a folder.
  const dirs = [...new Set(paths.map((p) => path.dirname(p)))];
  const real = new Map(await Promise.all(dirs.map(async (d) => [d, await fs.promises.realpath(d).catch(() => d)] as const)));
  const by = new Map<string, string>();
  for (const p of paths) {
    const r = path.join(real.get(path.dirname(p))!, path.basename(p));
    // The file's own path wins over one through a link.
    if (!by.has(r) || p === r) by.set(r, p);
  }
  return [...by.values()];
}
