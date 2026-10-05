// Shared compile-time protocol; type-only imports keep host dependencies out of the webview.
import type { SourceChange } from './sourceEdit';
import type { WordTargets } from './frontMatter';
import type { BlockKind } from './inlineEdit';
import type * as store from './commentStore';
import type { AgentKind } from './agentSessions';
import type { Changes, BaselineInfo, AgentState, Round, ReviewRun, Delivery } from './core';
import type { ReviewCommand } from '../webview/commands';
export type ToWebview =
  | { type: 'commentSaved'; requestId: string; id: string }
  | { type: 'commentSaveFailed'; requestId: string; message: string }
  | { type: 'deliveryFailed'; ids: string[]; message: string }
  | { type: 'command'; command: ReviewCommand }
  | { type: 'render'; source: string; blocks: string[]; fileName: string; targets?: WordTargets; changes?: Changes | null; changesFailed?: boolean }
  | { type: 'sourceSaved'; seq: number; source: string }
  | { type: 'sourceConflict'; seq: number; message: string }
  | { type: 'linkCheck'; missing: string[]; seq?: number }
  | { type: 'changes'; changes: Changes | null; failed?: boolean }
  | { type: 'baseline'; info: BaselineInfo | null }
  | { type: 'comments'; data: store.Sidecar; author: string; showResolved: boolean }
  | { type: 'block'; ls: number; le: number; text: string }
  | { type: 'blockSaved'; ls: number }
  | { type: 'inlineFailed'; ls: number; le: number; text: string; message: string }
  | { type: 'history'; canUndo: boolean; canRedo: boolean }
  | { type: 'toast'; message: string }
  | { type: 'agentPrompt'; prompt: string; count: number; review?: string }
  | { type: 'agent'; agent: AgentState }
  /** Browser mode: a command for the user to run in a terminal (the view copies it). */
  | { type: 'handOver'; command: string }
  | { type: 'reviewers'; presets: { id: string; label: string; path?: string }[] }
  | { type: 'prefs'; prefs: Record<string, unknown> }
  | { type: 'round'; round: Round | null }
  | { type: 'review'; review: ReviewRun | null }
  /** Jump to a thread picked in the review inbox. */
  | { type: 'focusThread'; id: string }
  | { type: 'error'; message: string };


export type FromWebview =
  | { type: 'ready' }
  | { type: 'saveSource'; original: string; changes: SourceChange[]; seq: number }
  | { type: 'addComment'; anchor: store.Anchor; body: string; meta?: store.CommentMeta; suggestion?: string; requestId?: string; send?: boolean }
  /** Apply a suggestion: the block's rendered text before and after, as for saveInline. */
  | { type: 'applySuggestion'; id: string; from?: string; ls: number; le: number; kind: BlockKind; oldText: string; newText: string }
  | { type: 'dismissSuggestion'; id: string; from?: string }
  | { type: 'setMeta'; id: string; meta: store.CommentMeta }
  | { type: 'reply'; id: string; body: string; parentId?: string }
  | { type: 'setStatus'; id: string; status: store.Status }
  | { type: 'editBody'; id: string; body: string; messageId?: string }
  | { type: 'deleteComment'; id: string }
  | { type: 'submitReview' }
  | { type: 'getBlock'; ls: number; le: number }
  | { type: 'saveBlock'; ls: number; le: number; original: string; newText: string }
  | { type: 'saveInline'; ls: number; le: number; kind: BlockKind; oldText: string; newText: string }
  | { type: 'openLink'; href: string }
  | { type: 'toggleTask'; line: number; checked: boolean; key?: string }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'sendToAgent'; id?: string }
  | { type: 'setPrefs'; prefs: Record<string, unknown> }
  | { type: 'composing'; on: boolean }
  /** Hide the Send to Claude progress ('round') or the Review with Claude one ('review'). */
  | { type: 'dismissRound'; which: 'round' | 'review' }
  | { type: 'listReviewers' }
  /** preset: a reviewer id from listReviewers, or 'custom' with the instruction typed in. */
  | { type: 'startReview'; preset: string; instruction?: string }
  /** An agent's draft: keep it as yours, or keep it and queue it for the agent's next Send. */
  | { type: 'triage'; id: string; action: 'keep' | 'do' }
  | { type: 'reanchor'; id: string; anchor: store.Anchor }
  | { type: 'checkLinks'; hrefs: string[]; seq?: number }
  | { type: 'showChanges'; on: boolean }
  /** Revert or keep hunk `i` of the comparison `v`. */
  | { type: 'revertChange'; v: string; i: number }
  | { type: 'keepChange'; v: string; i: number }
  | { type: 'acceptChanges' }
  /** The session menu opened: list the sessions it can bind to. */
  | { type: 'listSessions' }
  | { type: 'bindSession'; agent: AgentKind; id: string; name?: string }
  | { type: 'unbindSession' }
  | { type: 'startSession'; agent: AgentKind; resume?: string }
  | { type: 'setDelivery'; delivery: Delivery }
  /** Submit drafts and copy the prompt instead of sending it: for any other agent. */
  | { type: 'copyPrompt' }
  /** Install the skill and hooks in the workspace folder. */
  | { type: 'connectFolder' }
  /** Refresh the chip: is the bound session still running, idle or busy? */
  | { type: 'agentState' };
