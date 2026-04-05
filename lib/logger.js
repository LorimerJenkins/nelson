/**
 * Structured JSON-line logger with request ID tracing.
 *
 * Every log line is a single JSON object written to nelson.log.
 * Request IDs propagate through message handling → Claude calls → background tasks.
 *
 * Usage:
 *   const logger = require('./logger');
 *   const log = logger.child({ requestId: 'abc123', component: 'bot' });
 *   log.info('message received', { userId: 123 });
 *   log.error('failed', { err: error.message });
 */
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const LOG_FILE = path.join(__dirname, '..', 'nelson.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };
let minLevel = LEVELS.info;

function setLevel(level) {
  if (LEVELS[level] !== undefined) minLevel = LEVELS[level];
}

/**
 * Generate a short request ID for tracing.
 */
function requestId() {
  return randomUUID().slice(0, 8);
}

/**
 * Write a structured log line.
 */
function write(level, msg, fields = {}) {
  if (LEVELS[level] < minLevel) return;

  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  };

  // Remove undefined values
  for (const key of Object.keys(entry)) {
    if (entry[key] === undefined) delete entry[key];
  }

  const line = JSON.stringify(entry) + '\n';

  try {
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Last resort — write to stderr
    process.stderr.write(line);
  }

  // Also write errors/fatals to stderr for visibility
  if (LEVELS[level] >= LEVELS.error) {
    process.stderr.write(`[${level.toUpperCase()}] ${msg}\n`);
  }
}

/**
 * Create a child logger with default fields (e.g. requestId, component).
 * Child fields are merged into every log call.
 */
function child(defaults = {}) {
  return {
    debug: (msg, fields) => write('debug', msg, { ...defaults, ...fields }),
    info: (msg, fields) => write('info', msg, { ...defaults, ...fields }),
    warn: (msg, fields) => write('warn', msg, { ...defaults, ...fields }),
    error: (msg, fields) => write('error', msg, { ...defaults, ...fields }),
    fatal: (msg, fields) => write('fatal', msg, { ...defaults, ...fields }),
    child: (extra) => child({ ...defaults, ...extra }),
  };
}

/**
 * Rotate log file if it exceeds MAX_LOG_SIZE.
 * Keeps 2 old copies: nelson.log.1, nelson.log.2
 */
function rotateIfNeeded() {
  try {
    if (!fs.existsSync(LOG_FILE)) return false;
    const stats = fs.statSync(LOG_FILE);
    if (stats.size < MAX_LOG_SIZE) return false;

    const log2 = LOG_FILE + '.2';
    const log1 = LOG_FILE + '.1';
    try { fs.unlinkSync(log2); } catch {}
    try { fs.renameSync(log1, log2); } catch {}
    fs.renameSync(LOG_FILE, log1);
    fs.writeFileSync(LOG_FILE, '');
    write('info', 'Log rotated', { previousSize: stats.size });
    return true;
  } catch (err) {
    process.stderr.write(`Log rotation failed: ${err.message}\n`);
    return false;
  }
}

// Root logger
const root = child({ component: 'nelson' });

module.exports = {
  ...root,
  child,
  requestId,
  setLevel,
  rotateIfNeeded,
  LOG_FILE,
};
