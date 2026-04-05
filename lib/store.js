/**
 * Generic JSON file store with file locking.
 * Prevents concurrent read-modify-write corruption across all JSON data files.
 *
 * Usage:
 *   const store = require('./store');
 *   const tasks = store.load('/path/to/tasks.json', { active: [], completed: [] });
 *   await store.save('/path/to/tasks.json', data);
 *   await store.update('/path/to/tasks.json', (current) => { current.x = 1; return current; }, defaultVal);
 */
const fs = require('fs');
const lockfile = require('proper-lockfile');

const LOCK_OPTS = {
  retries: { retries: 5, minTimeout: 200, maxTimeout: 2000 },
  stale: 10000,
  update: 2000,
};

/**
 * Read a JSON file (no lock — safe for read-only).
 * @param {string} filePath - absolute path to JSON file
 * @param {*} fallback - default value if file missing or corrupt
 */
function load(filePath, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return typeof fallback === 'function' ? fallback() : JSON.parse(JSON.stringify(fallback));
  }
}

/**
 * Write JSON with an exclusive file lock.
 * Creates the file first if it doesn't exist (lockfile requires the file to exist).
 */
async function save(filePath, data) {
  ensureFileExists(filePath);
  let release;
  try {
    release = await lockfile.lock(filePath, LOCK_OPTS);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } finally {
    if (release) await release();
  }
}

/**
 * Synchronous save with lock (for non-async contexts).
 */
function saveSync(filePath, data) {
  ensureFileExists(filePath);
  let release;
  try {
    release = lockfile.lockSync(filePath, { stale: 10000 });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  } finally {
    if (release) release();
  }
}

/**
 * Atomic read-modify-write with lock held throughout.
 * @param {string} filePath
 * @param {function} updater - receives current data, returns updated data
 * @param {*} fallback - default if file missing
 * @returns {*} the updated data
 */
async function update(filePath, updater, fallback = {}) {
  ensureFileExists(filePath);
  let release;
  try {
    release = await lockfile.lock(filePath, LOCK_OPTS);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      data = typeof fallback === 'function' ? fallback() : JSON.parse(JSON.stringify(fallback));
    }
    const updated = updater(data);
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
    return updated;
  } finally {
    if (release) await release();
  }
}

/**
 * Synchronous atomic read-modify-write.
 */
function updateSync(filePath, updater, fallback = {}) {
  ensureFileExists(filePath);
  let release;
  try {
    release = lockfile.lockSync(filePath, { stale: 10000 });
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      data = typeof fallback === 'function' ? fallback() : JSON.parse(JSON.stringify(fallback));
    }
    const updated = updater(data);
    fs.writeFileSync(filePath, JSON.stringify(updated, null, 2));
    return updated;
  } finally {
    if (release) release();
  }
}

function ensureFileExists(filePath) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '{}');
  }
}

module.exports = { load, save, saveSync, update, updateSync };
