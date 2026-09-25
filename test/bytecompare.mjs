// node test/bytecompare.mjs <old> <new> — byte-level report of what changed.
import fs from 'node:fs';
const [a, b] = process.argv.slice(2).map((f) => fs.readFileSync(f));
let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
const lines = (buf) => { const out = []; let st = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 10) { out.push(buf.subarray(st, i + 1)); st = i + 1; } if (st < buf.length) out.push(buf.subarray(st)); return out; };
const la = lines(a), lb = lines(b);
const eol = (buf) => { let crlf = 0, lf = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 10) (buf[i - 1] === 13 ? crlf++ : lf++); return `CRLF=${crlf} LF-only=${lf}`; };
const changed = [];
for (let i = 0; i < Math.max(la.length, lb.length); i++) if (!(la[i] && lb[i] && la[i].equals(lb[i]))) changed.push(i + 1);
console.log(`old: ${a.length} bytes, ${la.length} lines, ${eol(a)}`);
console.log(`new: ${b.length} bytes, ${lb.length} lines, ${eol(b)}`);
console.log(`identical leading bytes: ${p}, identical trailing bytes: ${s}, differing window: ${a.length - p - s} old bytes -> ${b.length - p - s} new bytes`);
console.log(`lines that differ (same line count => positional): ${changed.length ? changed.join(', ') : 'none'}`);
for (const n of changed.slice(0, 10)) {
  console.log(`- L${n} old: ${JSON.stringify(la[n - 1]?.toString('utf8').slice(0, 90))}`);
  console.log(`+ L${n} new: ${JSON.stringify(lb[n - 1]?.toString('utf8').slice(0, 90))}`);
}
