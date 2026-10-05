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

// A mutation is one synchronous read-modify-write that takes milliseconds, so a
// local lock this old was leaked (e.g. its unlink failed) even if its owner lives.
const STALE_MS = 10000;

// Sync clients (Dropbox, OneDrive) and scanners briefly open new files, which
// makes unlink fail with EPERM/EBUSY on Windows. Retry instead of leaking.
function unlinkWithRetry(lock, io) {
  for (let attempt = 0; ; attempt++) {
    try { io.unlinkSync(lock); return true; }
    catch (error) {
      if (error.code === 'ENOENT') return true;
      if (!temporary(error) || attempt >= 20) return false;
      pause(25);
    }
  }
}

function acquire(file, io) {
  const lock = file + '.lock';
  const owner = JSON.stringify({ pid: process.pid, host: os.hostname() });
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      io.writeFileSync(lock, owner, { flag: 'wx' });
      // Never throw from release: the mutation already succeeded, and a lock that
      // still cannot be removed is recovered as stale by the next writer.
      return () => { try { if (readText(lock, io) === owner) unlinkWithRetry(lock, io); } catch { /* recovered as stale */ } };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Only recover a local lock whose owner has exited or that is stale. Never
      // guess whether a different machine (including a synced copy) is alive.
      try {
        const raw = readText(lock, io);
        const previous = JSON.parse(raw);
        if (previous.host === os.hostname() && Number.isInteger(previous.pid) && previous.pid > 0) {
          let exited = false;
          try { process.kill(previous.pid, 0); }
          catch (probe) { exited = probe.code === 'ESRCH'; }
          const stale = exited || Date.now() - io.statSync(lock).mtimeMs > STALE_MS;
          if (stale && readText(lock, io) === raw && unlinkWithRetry(lock, io)) continue;
        }
      } catch { /* A lock being created or released is briefly incomplete. */ }
      pause(15);
    }
  }
  throw new Error(`Comments are being updated by another process. Please retry. If this persists, delete ${lock}.`);
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
