// The MD Review tree in the Explorer: threads across the workspace, grouped by
// whose turn it is. Nothing is scanned until the view is first shown.
import * as vscode from 'vscode';
import * as path from 'path';
import { Comment, Sidecar } from './commentStore';
import { buildInbox, GROUPS, Inbox, InboxFile, InboxGroup, parseInboxSidecar, threadDescription, threadLabel } from './inbox';

const SIDECAR = '.comments.json';
const INCLUDE = '**/*.md.comments.json';
// Same rule as the CLI's folder walk; findFiles adds files.exclude on top.
const EXCLUDE = '{**/node_modules/**,**/.*/**}';
const CAP = 2000;

const ICONS: Record<InboxGroup, string> = { needsYou: 'comment-unresolved', waiting: 'watch', drafts: 'edit', resolved: 'check' };

type Node =
  | { kind: 'group'; group: InboxGroup; files: InboxFile[]; count: number }
  | { kind: 'file'; group: InboxGroup; file: InboxFile }
  | { kind: 'thread'; group: InboxGroup; mdPath: string; comment: Comment };

export class InboxView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  static readonly viewId = 'mdReview.inbox';

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<Node>;
  private readonly subs: vscode.Disposable[] = [];
  /** Parsed sidecars by path, reused while mtime and size are unchanged. */
  private readonly cache = new Map<string, { mtime: number; size: number; data: Sidecar | null }>();
  private inbox: Inbox | undefined;
  private scanning: Promise<void> | undefined;
  private started = false;
  private capped = false;
  private timer: NodeJS.Timeout | undefined;
  private dirty = new Set<string>();
  private full = false;
  private status: vscode.StatusBarItem | undefined;

  constructor() {
    this.view = vscode.window.createTreeView(InboxView.viewId, { treeDataProvider: this, showCollapseAll: true });
    this.subs.push(this.view, this.changed);
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (!node) {
      if (!this.started) this.start();
      await this.scanning;
      const inbox = this.inbox!;
      return GROUPS.filter((g) => inbox.counts[g.id]).map((g) => ({ kind: 'group', group: g.id, files: inbox.groups[g.id], count: inbox.counts[g.id] }));
    }
    if (node.kind === 'group') return node.files.map((file) => ({ kind: 'file', group: node.group, file }));
    if (node.kind === 'file') return node.file.threads.map((comment) => ({ kind: 'thread', group: node.group, mdPath: node.file.mdPath, comment }));
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
    const item = new vscode.TreeItem(threadLabel(c), E.None);
    item.id = `${node.group}/${node.mdPath}/${c.id}`;
    item.description = threadDescription(c);
    item.tooltip = c.body;
    item.iconPath = new vscode.ThemeIcon(c.kind === 'question' ? 'question' : 'comment');
    item.command = { command: 'mdReview.openThread', title: 'Open Thread', arguments: [node.mdPath, c.id] };
    return item;
  }

  /** Rescan the whole workspace (the view's Refresh action). */
  refresh(): void {
    if (!this.started) return this.start();
    this.full = true;
    this.schedule(0);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.subs.forEach((d) => d.dispose());
    this.status?.dispose();
  }

  /** First look at the view: scan, then keep up with changes. */
  private start(): void {
    this.started = true;
    const watcher = vscode.workspace.createFileSystemWatcher(INCLUDE);
    const onChange = (uri: vscode.Uri) => {
      if (!this.cache.has(uri.fsPath)) return; // not one we list
      this.dirty.add(uri.fsPath);
      this.schedule();
    };
    const onCreateOrDelete = (uri: vscode.Uri) => {
      if (hidden(uri)) return;
      this.full = true;
      this.schedule();
    };
    this.subs.push(
      watcher,
      watcher.onDidChange(onChange),
      watcher.onDidCreate(onCreateOrDelete),
      watcher.onDidDelete(onCreateOrDelete),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
    );
    this.scanning = this.scan(true);
  }

  private schedule(ms = 300): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const full = this.full;
      this.full = false;
      // Chain on a scan in flight so two never interleave.
      this.scanning = (this.scanning ?? Promise.resolve()).then(() => this.scan(full));
      void this.scanning.then(() => this.changed.fire());
    }, ms);
  }

  private async scan(full: boolean): Promise<void> {
    try {
      let paths: string[];
      if (full || !this.inbox) {
        const found = await vscode.workspace.findFiles(INCLUDE, EXCLUDE, CAP + 1);
        this.capped = found.length > CAP;
        paths = found.slice(0, CAP).map((u) => u.fsPath);
        const keep = new Set(paths);
        for (const p of this.cache.keys()) if (!keep.has(p)) this.cache.delete(p);
      } else paths = [...this.cache.keys()];
      const dirty = this.dirty;
      this.dirty = new Set();
      await Promise.all(paths.map((p) => this.load(p, dirty.has(p))));
    } catch {
      // Search unavailable (no folder open, cancelled): show what we have.
    }
    this.inbox = buildInbox([...this.cache].map(([sidecar, e]) => ({ mdPath: sidecar.slice(0, -SIDECAR.length), data: e.data })));
    this.update();
  }

  /** Read a sidecar unless the cached copy has the same mtime and size. */
  private async load(sidecar: string, force: boolean): Promise<void> {
    const uri = vscode.Uri.file(sidecar);
    try {
      const st = await vscode.workspace.fs.stat(uri);
      const hit = this.cache.get(sidecar);
      if (!force && hit && hit.mtime === st.mtime && hit.size === st.size) return;
      const raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      this.cache.set(sidecar, { mtime: st.mtime, size: st.size, data: parseInboxSidecar(raw, sidecar.slice(0, -SIDECAR.length)) });
    } catch {
      this.cache.delete(sidecar); // gone since the search
    }
  }

  private update(): void {
    const n = this.inbox!.counts.needsYou;
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
    this.status.tooltip = 'MD Review: threads where Claude replied and it is your turn';
    if (n) this.status.show();
    else this.status.hide();
  }
}

/** Sidecars in node_modules or dot-folders, which the inbox skips. */
function hidden(uri: vscode.Uri): boolean {
  return vscode.workspace
    .asRelativePath(uri, false)
    .split(/[\\/]/)
    .slice(0, -1)
    .some((s) => s === 'node_modules' || s.startsWith('.'));
}
