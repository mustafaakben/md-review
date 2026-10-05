import { diffSeq, diffWords } from '../src/wordDiff';
import type { ChangeSpec } from '@codemirror/state';

/** Small source transactions let CodeMirror map selections through external edits. */
export function externalChanges(before: string, after: string): ChangeSpec[] {
  if (before === after) return [];
  const result: ChangeSpec[] = [];
  const lines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const oldLines = lines(before), newLines = lines(after);
  const script = diffSeq(oldLines, newLines, 512);
  function changed(from: number, oldText: string, newText: string) {
    // Trim common edges even if a large rewrite exceeds the word-diff budget.
    let prefix = 0, suffix = 0;
    while (prefix < oldText.length && prefix < newText.length && oldText[prefix] === newText[prefix]) prefix++;
    while (suffix < oldText.length - prefix && suffix < newText.length - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) suffix++;
    from += prefix;
    oldText = oldText.slice(prefix, oldText.length - suffix);
    newText = newText.slice(prefix, newText.length - suffix);
    let at = from, start = from, removed = 0, inserted = '';
    const flush = () => {
      if (removed || inserted) result.push({ from: start, to: start + removed, insert: inserted });
      start = at; removed = 0; inserted = '';
    };
    for (const [edit, text] of diffWords(oldText, newText, 512)) {
      if (edit === 0) { flush(); at += text.length; start = at; }
      else if (edit === -1) { removed += text.length; at += text.length; }
      else inserted += text;
    }
    flush();
  }
  if (!script) { changed(0, before, after); return result; }
  let i = 0, j = 0, offset = 0, from = 0, oldText = '', newText = '';
  const flush = () => { if (oldText || newText) changed(from, oldText, newText); oldText = newText = ''; from = offset; };
  for (const edit of script) {
    if (edit === 0) { flush(); offset += oldLines[i++].length; j++; from = offset; }
    else if (edit === -1) { oldText += oldLines[i]; offset += oldLines[i++].length; }
    else newText += newLines[j++];
  }
  flush();
  return result;
}
