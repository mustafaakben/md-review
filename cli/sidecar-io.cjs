// Shared by the bundled host and the dependency-free CLI. Locks coordinate local
// MD Review writers; revision checks also detect edits from other applications.
const fs = require('node:fs');
const os = require('node:os');
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const temporary = error => ['EBUSY', 'EPERM', 'EACCES', 'EEXIST'].includes(error.code);

function readText(file, io = fs) {
  try { return io.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function acquire(file, io) {
  const lock = file + '.lock';
  const owner = JSON.stringify({ pid: process.pid, host: os.hostname() });
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      io.writeFileSync(lock, owner, { flag: 'wx' });
      return () => { if (readText(lock, io) === owner) io.unlinkSync(lock); };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Only recover a lock whose local owner is known to have exited. Never
      // guess whether a different machine (including a synced copy) is alive.
      try {
        const raw = readText(lock, io);
        const previous = JSON.parse(raw);
        if (previous.host === os.hostname() && Number.isInteger(previous.pid) && previous.pid > 0) {
          try { process.kill(previous.pid, 0); }
          catch (probe) {
            if (probe.code === 'ESRCH' && readText(lock, io) === raw) { io.unlinkSync(lock); continue; }
          }
        }
      } catch { /* A lock being created or released is briefly incomplete. */ }
      pause(15);
    }
  }
  throw new Error('Comments are being updated by another process. Please retry.');
}

function mutateSidecar(file, transform, options = {}) {
  const io = options.io || fs;
  const release = acquire(file, io);
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    for (let revision = 0; revision < 4; revision++) {
      const original = readText(file, io);
      if (original !== null && !original.trim()) throw new Error('The comments file is empty or still being written. Please retry; existing comments were not replaced.');
      const data = transform(original);
      const written = JSON.stringify(data, null, 2) + '\n';
      io.writeFileSync(tmp, written, 'utf8');
      for (let attempt = 0; attempt < 4; attempt++) {
        // Retry the mutation on the new data, never overwrite another writer's update.
        if (readText(file, io) !== original) break;
        try { io.renameSync(tmp, file); return { data, written }; }
        catch (error) {
          if (!temporary(error) || attempt === 3) throw error;
          pause(15);
        }
      }
    }
    throw new Error('Comments kept changing while saving. Please retry; newer comments were not replaced.');
  } finally {
    try { io.rmSync(tmp, { force: true }); } finally { release(); }
  }
}

module.exports = { readText, mutateSidecar };
