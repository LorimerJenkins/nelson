/**
 * Memory module with file locking for memory.json
 * Prevents concurrent read-modify-write corruption when multiple
 * async operations (background memory updates, life sync, message handling)
 * access memory.json simultaneously.
 */
const fs = require('fs');
const path = require('path');
const lockfile = require('proper-lockfile');

const MEMORY_FILE = path.join(__dirname, '..', 'memory.json');

// Lock options: retry up to 5 times with 200ms backoff, stale after 10s
const LOCK_OPTS = {
  retries: { retries: 5, minTimeout: 200, maxTimeout: 2000 },
  stale: 10000,
  update: 2000,
};

/**
 * Read memory.json (no lock — safe for read-only access)
 */
function loadMemory() {
  try {
    return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Write memory.json with an exclusive file lock.
 * Prevents two concurrent writes from clobbering each other.
 */
async function saveMemoryLocked(memory) {
  let release;
  try {
    release = await lockfile.lock(MEMORY_FILE, LOCK_OPTS);
    memory.last_updated = new Date().toISOString().split('T')[0];
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
  } finally {
    if (release) await release();
  }
}

/**
 * Synchronous save (backwards-compatible fallback for non-async contexts).
 * Uses lockfile.lockSync which blocks the event loop briefly.
 * Note: sync API doesn't support retries, so we use minimal options.
 */
function saveMemory(memory) {
  let release;
  try {
    release = lockfile.lockSync(MEMORY_FILE, { stale: 10000 });
    memory.last_updated = new Date().toISOString().split('T')[0];
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
  } finally {
    if (release) release();
  }
}

/**
 * Read-modify-write with lock held throughout.
 * Use this for atomic updates where you need to read current state,
 * transform it, and write back without races.
 *
 * @param {function} updater - receives current memory, returns updated memory
 * @returns {object} the updated memory
 */
async function updateMemoryLocked(updater) {
  let release;
  try {
    release = await lockfile.lock(MEMORY_FILE, LOCK_OPTS);
    let memory;
    try {
      memory = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'));
    } catch {
      memory = {};
    }
    const updated = updater(memory);
    updated.last_updated = new Date().toISOString().split('T')[0];
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(updated, null, 2));
    return updated;
  } finally {
    if (release) await release();
  }
}

module.exports = {
  MEMORY_FILE,
  loadMemory,
  saveMemory,
  saveMemoryLocked,
  updateMemoryLocked,
};
