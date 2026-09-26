// Minimal ZIP container, enough for .docx: write (deflate or store) and read
// (stored or deflated entries, via the central directory, within size
// limits). No ZIP64, no encryption. Uses node's zlib, so the extension stays
// dependency-free.
import * as zlib from 'zlib';

export interface ZipEntry {
  name: string;
  data: Buffer;
}

let CRC_TABLE: Uint32Array | undefined;
export function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d: Date): { time: number; date: number } {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function writeZip(entries: ZipEntry[], when = new Date()): Buffer {
  const { time, date } = dosTime(when);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const deflated = zlib.deflateRawSync(e.data);
    const store = deflated.length >= e.data.length;
    const body = store ? e.data : deflated;
    const crc = crc32(e.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(store ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(store ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

export class ZipError extends Error {}

/**
 * What reading accepts. A .docx is text and a few images; anything past these
 * is a damaged or hostile file (a "zip bomb"), refused before it is inflated.
 */
export const LIMITS = {
  /** The .docx itself. */
  file: 100 * 1024 * 1024,
  entries: 10000,
  /** One part, inflated. */
  entry: 64 * 1024 * 1024,
  /** Everything read from one file, inflated. */
  total: 160 * 1024 * 1024,
  /** Inflated / compressed, for parts over 1 MB. XML packs about 10:1; bombs, 1000:1. */
  ratio: 200,
};

/** A name that could point outside the archive's own tree: never looked up. */
function unsafeName(name: string): boolean {
  return !name || /[\\\0]|^\/|^[a-z]:/i.test(name) || name.split('/').some((seg) => seg === '..' || seg === '.');
}

export interface ZipReader {
  names: string[];
  /** One entry's bytes, inflated on demand; undefined when absent. Throws ZipError. */
  read(name: string): Buffer | undefined;
}

/**
 * Index a ZIP by its central directory without inflating anything. Entries
 * with unsafe names (absolute, "..", backslashes) are left out; ZIP64,
 * encryption and methods other than store/deflate are refused.
 */
export function openZip(buf: Buffer, limits = LIMITS): ZipReader {
  if (buf.length > limits.file) throw new ZipError(`The file is over ${limits.file / 1024 / 1024} MB.`);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError('Not a ZIP file (no end of central directory).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new ZipError('ZIP64 archives are not supported.');
  if (count > limits.entries) throw new ZipError(`Too many entries (${count}).`);
  const index = new Map<string, { flags: number; method: number; csize: number; usize: number; loc: number }>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('Damaged ZIP central directory.');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const loc = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x0800 ? 'utf8' : 'latin1', p + 46, Math.min(buf.length, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/') || unsafeName(name) || index.has(name)) continue;
    index.set(name, { flags, method, csize, usize, loc });
  }
  let total = 0;
  return {
    names: [...index.keys()],
    read(name) {
      const e = index.get(name);
      if (!e) return undefined;
      if (e.flags & 1) throw new ZipError(`${name} is encrypted.`);
      if (e.csize === 0xffffffff || e.usize === 0xffffffff) throw new ZipError('ZIP64 archives are not supported.');
      if (e.usize > limits.entry) throw new ZipError(`${name} is too large (${Math.round(e.usize / 1024 / 1024)} MB).`);
      if (e.usize > 1024 * 1024 && e.usize > e.csize * limits.ratio) throw new ZipError(`${name} is compressed suspiciously well; refusing to inflate it.`);
      if (total + e.usize > limits.total) throw new ZipError('The file inflates to too much data.');
      if (e.loc + 30 > buf.length || buf.readUInt32LE(e.loc) !== 0x04034b50) throw new ZipError(`Damaged ZIP entry ${name}.`);
      const start = e.loc + 30 + buf.readUInt16LE(e.loc + 26) + buf.readUInt16LE(e.loc + 28);
      if (start + e.csize > buf.length) throw new ZipError(`Damaged ZIP entry ${name}.`);
      const raw = buf.subarray(start, start + e.csize);
      let data: Buffer;
      if (e.method === 0) data = Buffer.from(raw);
      else if (e.method === 8) {
        try {
          // Never more than the size the directory declares, whatever the stream says.
          data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, e.usize) });
        } catch (err) {
          throw new ZipError(`Couldn't inflate ${name}: ${(err as Error).message}`);
        }
      } else throw new ZipError(`${name} uses an unsupported compression method (${e.method}).`);
      if (data.length !== e.usize) throw new ZipError(`${name} has the wrong size.`);
      // Counted only once read, so a damaged entry doesn't use up the allowance.
      total += data.length;
      return data;
    },
  };
}

/** Read every file entry (within the limits). Throws ZipError for anything that isn't a readable ZIP. */
export function readZip(buf: Buffer, limits = LIMITS): Map<string, Buffer> {
  const zip = openZip(buf, limits);
  return new Map(zip.names.map((n) => [n, zip.read(n)!]));
}
