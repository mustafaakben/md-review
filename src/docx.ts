// Markdown + review threads -> .docx with real Word comments. A small OOXML
// writer over the reading-view model (docModel.ts): paragraphs, headings,
// lists, quotes, code, tables, links, images, math as TeX. Each thread's quote
// is located in the view's text the same way the webview does, and the
// matching Word runs are wrapped in commentRangeStart/End.
import * as fs from 'fs';
import type { Comment, Reply, Suggestion } from './commentStore';
import { buildDocModel, Block, DocModel, Fmt, Para, Run, isLocalImage, resolveLocal } from './docModel';
import { isNetworkPath } from './bibliography';
import { isInside } from './localImage';
import { locate } from './textQuote';
import { writeZip, ZipEntry } from './zip';

export interface ExportOptions {
  markdown: string;
  comments: Comment[];
  /** Folder of the Markdown file (bibliography, images). */
  docDir?: string;
  /** Restricted Mode: the only folders images and the bibliography may be read from. */
  readableRoots?: string[];
  includeResolved?: boolean;
  includeReplies?: boolean;
  /** Reads a local image; defaults to fs.readFileSync. Return undefined to skip it. */
  readFile?: (absPath: string) => Buffer | undefined;
  when?: Date;
}

export interface ExportResult {
  docx: Buffer;
  /** Threads written as Word comments. */
  exported: number;
  /** Of those, placed on their quote (or heading, or first paragraph for document threads). */
  anchored: number;
  /** Listed under "Unanchored comments" because their quote wasn't found. */
  unanchored: number;
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
// Threaded replies and "resolved" (Word 2013+): commentsExtended.xml, keyed by each comment's last paragraph id.
const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml';
const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';

/** Escape for XML text and attributes; drops characters XML 1.0 can't carry. */
export function xml(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wordDate(iso: string | undefined, fallback: Date): string {
  const d = iso ? new Date(iso) : fallback;
  return (isNaN(d.getTime()) ? fallback : d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function initials(name: string): string {
  return (
    name
      .split(/[\s._-]+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .slice(0, 3)
      .toUpperCase() || '?'
  );
}

interface Placed {
  wid: number;
  c: Comment;
  s: number;
  e: number;
  /** Set for a reply: a Word comment of its own on the same range, threaded under the thread's. */
  reply?: Reply;
}

/** The w14:paraId of a Word comment's (last) paragraph: 8 hex digits below 0x80000000. */
const paraId = (wid: number) => (0x10000000 + wid).toString(16).toUpperCase();

/** Every run in document order (table cells included). */
function allRuns(blocks: Block[], out: Run[] = []): Run[] {
  for (const b of blocks) {
    if (b.type === 'p') out.push(...b.runs);
    else for (const row of b.rows) for (const cell of row.cells) allRuns(cell, out);
  }
  return out;
}

function covered(runs: Run[], s: number, e: number): boolean {
  return runs.some((r) => r.a1 > r.a0 && r.a1 > s && r.a0 < e);
}

function firstParaRange(blocks: Block[]): [number, number] | null {
  for (const b of blocks) {
    if (b.type === 'p') {
      const rs = b.runs.filter((r) => r.a1 > r.a0);
      if (rs.length) return [rs[0].a0, rs[rs.length - 1].a1];
    } else {
      for (const row of b.rows) for (const cell of row.cells) {
        const r = firstParaRange(cell);
        if (r) return r;
      }
    }
  }
  return null;
}

// ---- images ----

/** Larger files are left out (shown as their alt text), as the view does past 8 MB. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Whether the export may read the local image `file`: inside the readable
 * roots when there are any (Restricted Mode), and never a Windows network
 * path outside the document's own folder (reading it would connect there).
 */
function mayRead(file: string, opts: ExportOptions): boolean {
  if (opts.readableRoots && !opts.readableRoots.some((r) => isInside(r, file))) return false;
  return !isNetworkPath(file) || (!!opts.docDir && isInside(opts.docDir, file));
}

/** A regular file up to the size limit (never a device or a pipe, which would not finish). */
function readImage(file: string): Buffer | undefined {
  const st = fs.statSync(file);
  return st.isFile() && st.size <= MAX_IMAGE_BYTES ? fs.readFileSync(file) : undefined;
}

interface Img {
  rid: string;
  file: string;
  cx: number;
  cy: number;
  n: number;
}

function imageInfo(data: Buffer): { ext: 'png' | 'jpeg'; w: number; h: number } | null {
  if (data.length > 24 && data.readUInt32BE(0) === 0x89504e47) return { ext: 'png', w: data.readUInt32BE(16), h: data.readUInt32BE(20) };
  if (data.length > 4 && data[0] === 0xff && data[1] === 0xd8) {
    let p = 2;
    while (p + 9 < data.length) {
      if (data[p] !== 0xff) {
        p++;
        continue;
      }
      const m = data[p + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) {
        p += m === 0xff ? 1 : 2;
        continue;
      }
      const len = data.readUInt16BE(p + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { ext: 'jpeg', h: data.readUInt16BE(p + 5), w: data.readUInt16BE(p + 7) };
      }
      p += 2 + len;
    }
  }
  return null;
}

// ---- the writer ----

class Writer {
  rels: string[] = [];
  media: ZipEntry[] = [];
  private links = new Map<string, string>();
  private images = new Map<string, Img | null>();
  private nextRel = 5;
  private drawings = 0; // docPr ids must be unique per drawing, even for a repeated image
  private open = new Set<number>();
  private pending: Placed[];
  private placed = new Map<number, Placed>();

  constructor(
    placed: Placed[],
    private opts: ExportOptions,
  ) {
    this.pending = [...placed].sort((a, b) => a.s - b.s || a.wid - b.wid);
    for (const p of placed) this.placed.set(p.wid, p);
  }

  private rel(type: string, target: string, external: boolean): string {
    const id = `rId${this.nextRel++}`;
    this.rels.push(`<Relationship Id="${id}" Type="${REL}/${type}" Target="${xml(target)}"${external ? ' TargetMode="External"' : ''}/>`);
    return id;
  }

  private link(href: string): string {
    let id = this.links.get(href);
    if (!id) this.links.set(href, (id = this.rel('hyperlink', href, true)));
    return id;
  }

  private image(src: string): Img | null {
    if (this.images.has(src)) return this.images.get(src)!;
    let data: Buffer | undefined;
    try {
      const m = /^data:image\/(png|jpe?g);base64,(.*)$/is.exec(src);
      if (m) data = Buffer.from(m[2], 'base64');
      else if (isLocalImage(src) && this.opts.docDir) {
        const p = resolveLocal(this.opts.docDir, src);
        if (mayRead(p, this.opts)) data = (this.opts.readFile ?? readImage)(p);
      }
    } catch {
      data = undefined;
    }
    const info = data && data.length <= MAX_IMAGE_BYTES ? imageInfo(data) : null;
    let img: Img | null = null;
    if (data && info && info.w > 0 && info.h > 0) {
      const n = this.media.length + 1;
      const file = `media/image${n}.${info.ext}`;
      this.media.push({ name: `word/${file}`, data });
      const max = 5943600; // 6.5in in EMU
      let cx = info.w * 9525;
      let cy = info.h * 9525;
      if (cx > max) {
        cy = Math.round((cy * max) / cx);
        cx = max;
      }
      img = { rid: this.rel('image', file, false), file, cx, cy, n };
    }
    this.images.set(src, img);
    return img;
  }

  private startMarker(p: Placed): string {
    this.open.add(p.wid);
    return `<w:commentRangeStart w:id="${p.wid}"/>`;
  }
  private endMarker(p: Placed): string {
    this.open.delete(p.wid);
    return `<w:commentRangeEnd w:id="${p.wid}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${p.wid}"/></w:r>`;
  }

  private rPr(f: Fmt): string {
    let s = '';
    if (f.link) s += '<w:rStyle w:val="Hyperlink"/>';
    if (f.code) s += '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>';
    if (f.b) s += '<w:b/>';
    if (f.i) s += '<w:i/>';
    if (f.strike) s += '<w:strike/>';
    if (f.code) s += '<w:sz w:val="20"/>';
    if (f.mark) s += '<w:highlight w:val="yellow"/>';
    if (f.u) s += '<w:u w:val="single"/>';
    if (f.sup) s += '<w:vertAlign w:val="superscript"/>';
    else if (f.sub) s += '<w:vertAlign w:val="subscript"/>';
    return s ? `<w:rPr>${s}</w:rPr>` : '';
  }

  private textRun(text: string, f: Fmt, code: boolean): string {
    if (!text) return '';
    let body = '';
    let buf = '';
    const flush = () => {
      if (buf) body += `<w:t xml:space="preserve">${xml(buf)}</w:t>`;
      buf = '';
    };
    for (const ch of text) {
      if (ch === '\t') {
        flush();
        body += '<w:tab/>';
      } else if (ch === '\n' && code) {
        flush();
        body += '<w:br/>';
      } else if (ch === '\n' || ch === '\r') buf += ' ';
      else buf += ch;
    }
    flush();
    const r = `<w:r>${this.rPr(f)}${body}</w:r>`;
    return f.link ? `<w:hyperlink r:id="${this.link(f.link)}" w:history="1">${r}</w:hyperlink>` : r;
  }

  private drawing(img: Img, alt: string): string {
    return (
      `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${img.cx}" cy="${img.cy}"/>` +
      `<wp:docPr id="${++this.drawings}" name="Picture ${this.drawings}" descr="${xml(alt)}"/>` +
      `<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>` +
      `<pic:nvPicPr><pic:cNvPr id="0" name="${xml(img.file.slice(6))}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${img.rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${img.cx}" cy="${img.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
      `</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`
    );
  }

  /** One run with any comment markers that fall inside it. */
  private run(r: Run, code: boolean): string {
    if (r.kind === 'br') return '<w:r><w:br/></w:r>';
    if (r.kind === 'image') {
      const img = this.image(r.image!.src);
      if (img) return this.drawing(img, r.image!.alt);
      const alt = r.image!.alt.trim();
      return this.textRun(alt ? `[${alt}]` : '[image]', { ...r.fmt, i: true }, false);
    }
    if (r.a1 <= r.a0) return this.textRun(r.text, r.fmt, code);
    const len = r.text.length;
    const cut = (x: number) => (r.split ? Math.max(0, Math.min(len, x - r.a0)) : null);
    const events: { off: number; rank: number; html: () => string }[] = [];
    const startedHere = new Map<number, number>();
    while (this.pending.length && this.pending[0].s < r.a1) {
      const p = this.pending.shift()!;
      const off = cut(p.s) ?? 0;
      startedHere.set(p.wid, off);
      events.push({ off, rank: 1, html: () => this.startMarker(p) });
    }
    for (const wid of [...this.open, ...startedHere.keys()]) {
      const p = this.placed.get(wid)!;
      if (p.e > r.a1) continue;
      let off = cut(p.e) ?? len;
      const from = startedHere.get(wid);
      const rank = from === undefined ? 0 : 2;
      if (from !== undefined) off = Math.max(off, from);
      events.push({ off, rank, html: () => this.endMarker(p) });
    }
    events.sort((a, b) => a.off - b.off || a.rank - b.rank);
    let out = '';
    let at = 0;
    for (const ev of events) {
      if (ev.off > at) {
        out += this.textRun(r.text.slice(at, ev.off), r.fmt, code);
        at = ev.off;
      }
      out += ev.html();
    }
    out += this.textRun(r.text.slice(at), r.fmt, code);
    return out;
  }


  para(p: Para): string {
    let pPr = '';
    if (p.style) pPr += `<w:pStyle w:val="${p.style}"/>`;
    if (p.list) pPr += `<w:numPr><w:ilvl w:val="${p.list.ilvl}"/><w:numId w:val="${p.list.id + 1}"/></w:numPr>`;
    if (p.hr) pPr += '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr>';
    if (p.indent) pPr += `<w:ind w:left="${p.indent}"/>`;
    let body = '';
    for (const r of p.runs) body += this.run(r, !!p.code);
    return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${body}</w:p>`;
  }

  /** Close whatever is still open, inside the last paragraph written. */
  closeAll(): string {
    let out = '';
    for (const wid of [...this.open]) out += this.endMarker(this.placed.get(wid)!);
    return out;
  }

  blocks(blocks: Block[]): string {
    let out = '';
    for (const b of blocks) {
      if (b.type === 'p') out += this.para(b);
      else out += this.table(b);
    }
    return out;
  }

  table(t: Extract<Block, { type: 'table' }>): string {
    const cols = Math.max(1, ...t.rows.map((r) => r.cells.length));
    const w = Math.floor(9360 / cols);
    let out =
      `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="pct"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>` +
      `<w:tblGrid>${`<w:gridCol w:w="${w}"/>`.repeat(cols)}</w:tblGrid>`;
    for (const row of t.rows) {
      out += `<w:tr>${row.header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}`;
      for (let i = 0; i < cols; i++) {
        const cell = row.cells[i] || [];
        let inner = this.blocks(cell);
        if (!cell.length || cell[cell.length - 1].type !== 'p') inner += '<w:p/>';
        out += `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${inner}</w:tc>`;
      }
      out += '</w:tr>';
    }
    return out + '</w:tbl>';
  }
}


/** The line under a comment that carries its suggested edit (read back by import). */
export function suggestionLine(sg: Suggestion | undefined): string | null {
  if (!sg || sg.dismissedAt || sg.appliedAt) return null;
  return `Suggested edit: ${sg.text ? `replace with “${sg.text}”` : 'delete this text'}`;
}

function commentXml(p: Placed, when: Date): string {
  const c = p.c;
  const paras: { line: string; i?: boolean }[] = [];
  const add = (text: string, i?: boolean) => {
    for (const line of text.split(/\r?\n/)) paras.push({ line, i });
  };
  const author = (p.reply ? p.reply.author : c.author) || 'Unknown';
  add((p.reply ? p.reply.body : c.body) || '');
  if (!p.reply) {
    const meta = [c.kind && c.kind !== 'comment' ? c.kind : '', c.severity || '', c.scope === 'section' ? 'section' : c.scope === 'document' ? 'whole document' : '', c.status === 'resolved' ? 'resolved' : '']
      .filter(Boolean)
      .join(' · ');
    if (meta) add(`[${meta}]`, true);
  }
  const sugg = suggestionLine(p.reply ? p.reply.suggestion : c.suggestion);
  if (sugg) add(sugg, true);
  const body = paras
    .map(({ line, i }, n) => {
      const ref = n === 0 ? '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>' : '';
      const run = line ? `<w:r>${i ? '<w:rPr><w:i/></w:rPr>' : ''}<w:t xml:space="preserve">${xml(line)}</w:t></w:r>` : '';
      const id = n === paras.length - 1 ? ` w14:paraId="${paraId(p.wid)}" w14:textId="77777777"` : '';
      return `<w:p${id}><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>${ref}${run}</w:p>`;
    })
    .join('');
  const date = wordDate(p.reply ? p.reply.createdAt : c.createdAt, when);
  return `<w:comment w:id="${p.wid}" w:author="${xml(author)}" w:date="${date}" w:initials="${xml(initials(author))}">${body}</w:comment>`;
}

/** Threads each reply under its thread's first comment, and marks resolved threads done. */
function commentsExtendedXml(placed: Placed[]): string {
  const parent = new Map<Comment, number>();
  let out = '';
  for (const p of placed) {
    if (!p.reply) parent.set(p.c, p.wid);
    const up = p.reply ? ` w15:paraIdParent="${paraId(parent.get(p.c)!)}"` : '';
    out += `<w15:commentEx w15:paraId="${paraId(p.wid)}"${up} w15:done="${!p.reply && p.c.status === 'resolved' ? 1 : 0}"/>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w15:commentsEx xmlns:mc="${MC}" xmlns:w15="${W15}" mc:Ignorable="w15">${out}</w15:commentsEx>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="${W}">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="120"/></w:pPr><w:rPr><w:sz w:val="48"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:rPr><w:color w:val="595959"/><w:sz w:val="28"/></w:rPr></w:style>
${[40, 32, 28, 24, 22, 22]
  .map(
    (sz, i) =>
      `<w:style w:type="paragraph" w:styleId="Heading${i + 1}"><w:name w:val="heading ${i + 1}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:keepLines/><w:spacing w:before="${i < 2 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${i}"/></w:pPr><w:rPr><w:b/>${i >= 4 ? '<w:i/>' : ''}<w:sz w:val="${sz}"/></w:rPr></w:style>`,
  )
  .join('\n')}
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="BFBFBF"/></w:pBdr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/><w:color w:val="404040"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F3F3"/><w:spacing w:after="160" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="CommentText"><w:name w:val="annotation text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60" w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:rPr><w:sz w:val="16"/></w:rPr></w:style>
<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:basedOn w:val="TableNormal"/><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;

function numberingXml(model: DocModel): string {
  const bullets = ['•', '◦', '▪'];
  const fmts = ['decimal', 'lowerLetter', 'lowerRoman'];
  const lvl = (i: number, ordered: boolean) =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${ordered ? fmts[i % 3] : 'bullet'}"/><w:lvlText w:val="${ordered ? `%${i + 1}.` : bullets[i % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (i + 1)}" w:hanging="360"/></w:pPr></w:lvl>`;
  const abs = (id: number, ordered: boolean) =>
    `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>${Array.from({ length: 9 }, (_, i) => lvl(i, ordered)).join('')}</w:abstractNum>`;
  const nums = model.lists
    .map(
      (l, i) =>
        `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${l.ordered ? 1 : 0}"/>${l.ordered ? `<w:lvlOverride w:ilvl="${l.ilvl}"><w:startOverride w:val="${l.start}"/></w:lvlOverride>` : ''}</w:num>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering xmlns:w="${W}">${abs(0, false)}${abs(1, true)}${nums}</w:numbering>`;
}

/** Which threads go to Word, per the export options. */
export function threadsToExport(comments: Comment[], includeResolved = false): Comment[] {
  return comments.filter((c) => includeResolved || c.status !== 'resolved');
}

export function exportDocx(opts: ExportOptions): ExportResult {
  const when = opts.when ?? new Date();
  const model = buildDocModel(opts.markdown, { docDir: opts.docDir, readableRoots: opts.readableRoots });
  const runs = allRuns(model.blocks);
  const threads = threadsToExport(opts.comments, opts.includeResolved);
  const placed: Placed[] = [];
  const orphans: Comment[] = [];
  const first = firstParaRange(model.blocks);
  for (const c of threads) {
    let r: [number, number] | null = null;
    if (c.scope === 'document') r = first;
    else if (c.anchor.quote) r = locate(model.text, c.anchor);
    if (r && covered(runs, r[0], r[1])) placed.push({ wid: -1, c, s: r[0], e: r[1] });
    else orphans.push(c);
  }
  placed.sort((a, b) => a.s - b.s || a.e - b.e);
  const anchored = placed.length;

  // Threads whose quote is gone: listed at the end, each on its own paragraph.
  const tail: Block[] = [];
  if (orphans.length) {
    let at = model.text.length + 1;
    tail.push({ type: 'p', style: 'Heading1', runs: [{ kind: 'text', text: 'Unanchored comments', a0: at, a1: at, split: false, fmt: {} }] });
    for (const c of orphans) {
      const label = c.anchor.quote ? `“${c.anchor.quote}”` : '(no quoted text)';
      tail.push({ type: 'p', runs: [{ kind: 'text', text: label, a0: at, a1: at + label.length, split: true, fmt: { i: true } }] });
      placed.push({ wid: -1, c, s: at, e: at + label.length });
      at += label.length + 1;
    }
  }

  // Each reply follows its thread, on the same range; ids go in that order.
  const all = placed.flatMap((p) => [p, ...(opts.includeReplies ? p.c.replies.map((reply) => ({ ...p, reply })) : [])]);
  all.forEach((p, i) => (p.wid = i));

  const w = new Writer(all, opts);
  let body = w.blocks([...model.blocks, ...tail]);
  const rest = w.closeAll();
  if (rest) body += `<w:p>${rest}</w:p>`;
  if (!body) body = '<w:p/>';

  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document xmlns:w="${W}" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const comments =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:comments xmlns:w="${W}" xmlns:w14="${W14}" xmlns:mc="${MC}" mc:Ignorable="w14">` +
    `${all.map((p) => commentXml(p, when)).join('')}</w:comments>`;
  const docRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PKG}">` +
    `<Relationship Id="rId1" Type="${REL}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rId2" Type="${REL}/numbering" Target="numbering.xml"/>` +
    `<Relationship Id="rId3" Type="${REL}/comments" Target="comments.xml"/>` +
    `<Relationship Id="rId4" Type="http://schemas.microsoft.com/office/2011/relationships/commentsExtended" Target="commentsExtended.xml"/>` +
    w.rels.join('') +
    `</Relationships>`;
  const types =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="png" ContentType="image/png"/>` +
    `<Default Extension="jpeg" ContentType="image/jpeg"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>` +
    `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>` +
    `<Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/>` +
    `</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PKG}"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`;
  const u = (s: string) => Buffer.from(s, 'utf8');
  const docx = writeZip(
    [
      { name: '[Content_Types].xml', data: u(types) },
      { name: '_rels/.rels', data: u(rootRels) },
      { name: 'word/document.xml', data: u(document) },
      { name: 'word/styles.xml', data: u(STYLES) },
      { name: 'word/numbering.xml', data: u(numberingXml(model)) },
      { name: 'word/comments.xml', data: u(comments) },
      { name: 'word/commentsExtended.xml', data: u(commentsExtendedXml(all)) },
      { name: 'word/_rels/document.xml.rels', data: u(docRels) },
      ...w.media,
    ],
    when,
  );
  return { docx, exported: placed.length, anchored, unanchored: orphans.length };
}
