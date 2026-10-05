export type ReviewCommand = 'comment' | 'comments' | 'reply' | 'next' | 'prev' | 'nextChange' | 'prevChange' | 'shortcuts' | 'send' | 'submit' | 'undo' | 'redo' | 'find' | 'outline' | 'zoomIn' | 'zoomOut' | 'zoomReset' | 'reading' | 'review' | 'severity1' | 'severity2' | 'severity3';
type Key = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'getModifierState'>;
export function commandForKey(e: Key, mac: boolean): ReviewCommand | null {
  const mod = mac ? e.metaKey : e.ctrlKey;
  const chord = mod && e.altKey && !e.shiftKey && !e.getModifierState('AltGraph');
  if (chord) {
    const keys: Record<string, ReviewCommand> = { KeyM: 'comment', KeyP: 'comments', KeyY: 'reply', KeyJ: 'next', KeyK: 'prev', Comma: 'shortcuts' };
    if (keys[e.code]) return keys[e.code];
    if (mac && e.code === 'BracketRight') return 'nextChange';
    if (mac && e.code === 'BracketLeft') return 'prevChange';
  }
  if (!mac && e.altKey && !mod && e.key === 'F5') return e.shiftKey ? 'prevChange' : 'nextChange';
  if (!mod || e.getModifierState('AltGraph')) return null;
  if (e.key === 'Enter') return e.altKey && !e.shiftKey ? 'send' : e.shiftKey && !e.altKey ? 'submit' : null;
  if (e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === 'z') return e.shiftKey ? 'redo' : 'undo';
  if (!mac && key === 'y' && !e.shiftKey) return 'redo';
  if (key === 'f' && !e.shiftKey) return 'find';
  if (key === 'o' && e.shiftKey) return 'outline';
  if (e.key === '=' || e.key === '+') return 'zoomIn';
  if (e.key === '-' || e.key === '_') return 'zoomOut';
  if (e.key === '0' && !e.shiftKey) return 'zoomReset';
  return null;
}
export function isSaveReply(e: Key, mac: boolean): boolean {
  return e.key === 'Enter' && (mac ? e.metaKey : e.ctrlKey) && !e.altKey && !e.shiftKey;
}
export function nativeTextHistory(target: EventTarget | null, command: ReviewCommand | null): boolean {
  const el = target as HTMLElement | null;
  return (command === 'undo' || command === 'redo') && !!el && !el.closest('#mdr-canvas') && (el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName));
}
