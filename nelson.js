require('dotenv').config();
const { Telegraf } = require('telegraf');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require('./lib/logger');
const store = require('./lib/store');

const BASE_DIR = __dirname;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.TELEGRAM_ALLOWED_USER_ID);
const memory_mod = require('./lib/memory');
const MEMORY_FILE = memory_mod.MEMORY_FILE;
const memoryTiers = require('./lib/memory-tiers');
const HISTORY_FILE = path.join(BASE_DIR, 'conversation_history.json');
const PID_FILE = path.join(BASE_DIR, 'nelson.pid');
const ERROR_LOG = path.join(BASE_DIR, 'error_log.json');
const TOPICS_FILE = path.join(BASE_DIR, 'data', 'current_topics.json');
const SESSIONS_FILE = path.join(BASE_DIR, 'sessions.json');
const MAX_HISTORY = 10;
const CONVERSATIONS_DIR = path.join(
  process.env.HOME, '.claude/projects/-Users-nelson-nelson/memory/conversations'
);
const os = require('os');
const usage = require('./lib/usage');
const tasks = require('./lib/tasks');
const { hooks, retryWithBackoff, classifyError, ERROR_TYPES } = require('./lib/hooks');
const { MessageQueue } = require('./lib/queue');
const { CommandRouter } = require('./lib/commands');
const https = require('https');
const http = require('http');
// Map of msgId → timestamp for dedup with TTL-based cleanup
const processedMessages = new Map();
const BOT_START_TIME = Math.floor(Date.now() / 1000);
const BOOT_TIME = Date.now();
const CLAUDE = process.env.CLAUDE_PATH || 'claude';
const ENV = { ...process.env, PATH: `${path.dirname(CLAUDE)}:/usr/local/bin:/usr/bin:/bin` };

// Message queue — processes messages sequentially to prevent interleaving
const messageQueue = new MessageQueue({ concurrency: 1, maxDepth: 20, timeout: 360000 });

// PID lock — prevent duplicate instances
function acquireLock() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
      try {
        process.kill(oldPid, 0);
        log.fatal('Nelson already running, exiting', { existingPid: oldPid });
        process.exit(0);
      } catch {
        // Old process is dead — stale PID file, safe to overwrite
      }
    }
  } catch {}
  fs.writeFileSync(PID_FILE, String(process.pid));
  log.info('PID lock acquired', { pid: process.pid });
}

function releaseLock() {
  try {
    const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
    if (parseInt(pid) === process.pid) fs.unlinkSync(PID_FILE);
  } catch {}
}

function logError(type, message, context = '', diagnose = false) {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      message: String(message).slice(0, 1000),
      context: String(context).slice(0, 500),
      resolved: false,
      diagnosis: null
    };
    // Use locked update to prevent concurrent corruption
    store.updateSync(ERROR_LOG, (errors) => {
      if (!Array.isArray(errors)) errors = [];
      errors.push(entry);
      if (errors.length > 200) errors = errors.slice(-200);
      return errors;
    }, []);
    log.error('error logged', { errorType: type, message: String(message).slice(0, 200) });
    if (diagnose) setImmediate(() => diagnoseError(-1, entry));
  } catch (err) {
    log.error('logError itself failed', { err: err.message });
  }
}

function diagnoseError(index, entry) {
  // Run diagnosis async so it doesn't block the event loop
  (async () => {
    try {
      const prompt = `You are Nelson, an AI agent running as a Telegram bot. An unhandled error just occurred. Analyse it and suggest a concrete fix.

Error type: ${entry.type}
Error message: ${entry.message}
Context: ${entry.context}

Respond in this exact format:
CAUSE: <one-line root cause>
FIX: <specific code change or config fix needed>
SEVERITY: <low/medium/high>

Be specific — reference function names, line numbers, or exact changes needed. Keep it under 200 words.`;

      const diagnosis = (await callClaudeAsync(prompt, { timeout: 60000, callType: 'error_diagnosis' })).trim();
      // Append diagnosis to the most recent matching error
      await store.update(ERROR_LOG, (errors) => {
        if (!Array.isArray(errors)) return errors;
        // Find the last error matching this entry's timestamp
        for (let i = errors.length - 1; i >= 0; i--) {
          if (errors[i].timestamp === entry.timestamp && errors[i].type === entry.type) {
            errors[i].diagnosis = diagnosis;
            break;
          }
        }
        return errors;
      }, []);
      // Proactive alert — message Lorimer about the unhandled error
      if (botInstance && ALLOWED_USER_ID) {
        const time = entry.timestamp.split('T')[1].slice(0, 5);
        const alert = `⚠️ *Unhandled error at ${time}*\n\n\`${entry.type}\`: ${entry.message.slice(0, 300)}\n\n_Diagnosis:_\n${diagnosis.slice(0, 500)}`;
        botInstance.telegram.sendMessage(ALLOWED_USER_ID, alert, { parse_mode: 'Markdown' }).catch(() => {
          botInstance.telegram.sendMessage(ALLOWED_USER_ID, alert.replace(/[*_`]/g, '')).catch(() => {});
        });
      }
    } catch (err) {
      log.error('Error diagnosis failed', { err: err.message });
    }
  })();
}

acquireLock();

if (!TOKEN || !ALLOWED_USER_ID) {
  log.fatal('Missing required environment variables — copy .env.example to .env');
  process.exit(1);
}

// Memory functions — delegated to lib/memory.js (with file locking)
const loadMemory = memory_mod.loadMemory;
const saveMemory = memory_mod.saveMemory;
const saveMemoryLocked = memory_mod.saveMemoryLocked;
const updateMemoryLocked = memory_mod.updateMemoryLocked;

function loadHistory() {
  return store.load(HISTORY_FILE, []);
}

function saveHistory(history) {
  store.saveSync(HISTORY_FILE, history);
}

function addToHistory(role, text) {
  store.updateSync(HISTORY_FILE, (history) => {
    if (!Array.isArray(history)) history = [];
    history.push({ role, text: text.slice(0, 2000), timestamp: new Date().toISOString() });
    while (history.length > MAX_HISTORY) history.shift();
    return history;
  }, []);
}

function loadTopics() {
  try {
    const topics = JSON.parse(fs.readFileSync(TOPICS_FILE, 'utf8'));
    // Reset completed_today if it's a new day
    const today = new Date().toISOString().split('T')[0];
    if (topics.last_updated !== today) {
      topics.completed_today = [];
      topics.last_updated = today;
      fs.writeFileSync(TOPICS_FILE, JSON.stringify(topics, null, 2));
    }
    return topics;
  } catch { return { active: [], completed_today: [], last_updated: new Date().toISOString().split('T')[0] }; }
}

function topicsBlock() {
  const topics = loadTopics();
  if (topics.active.length === 0 && topics.completed_today.length === 0) return '';
  let block = '\n\nActive topics tracker:';
  if (topics.active.length > 0) block += `\nIN PROGRESS: ${topics.active.join(', ')}`;
  if (topics.completed_today.length > 0) block += `\nCOMPLETED TODAY: ${topics.completed_today.join(', ')}`;
  return block;
}

// --- Session management ---
const { randomUUID } = require('crypto');

const SESSIONS_DEFAULT = { sessions: {}, active_session: null };

function loadSessions() {
  return store.load(SESSIONS_FILE, SESSIONS_DEFAULT);
}

function saveSessions(data) {
  store.saveSync(SESSIONS_FILE, data);
}

function getSession(name) {
  const data = loadSessions();
  return data.sessions[name] || null;
}

function createSession(name) {
  const data = loadSessions();
  const id = randomUUID();
  data.sessions[name] = {
    id,
    created: new Date().toISOString(),
    last_used: new Date().toISOString(),
    message_count: 0
  };
  saveSessions(data);
  return id;
}

function touchSession(name) {
  const data = loadSessions();
  if (data.sessions[name]) {
    data.sessions[name].last_used = new Date().toISOString();
    data.sessions[name].message_count++;
    data.active_session = name;
    saveSessions(data);
  }
}

function setActiveSession(name) {
  const data = loadSessions();
  data.active_session = name;
  saveSessions(data);
}

function listSessions() {
  const data = loadSessions();
  return Object.entries(data.sessions).map(([name, s]) => ({
    name,
    id: s.id,
    created: s.created,
    last_used: s.last_used,
    message_count: s.message_count,
    active: name === data.active_session
  }));
}

function archiveSession(name) {
  const data = loadSessions();
  if (!data.sessions[name]) return;
  // Move to archived list
  if (!data.archived) data.archived = [];
  data.archived.push({
    name,
    ...data.sessions[name],
    archived_at: new Date().toISOString()
  });
  // Keep last 50 archived sessions
  if (data.archived.length > 50) data.archived = data.archived.slice(-50);
  delete data.sessions[name];
  // If this was active, clear active session
  if (data.active_session === name) data.active_session = null;
  saveSessions(data);
}

function isFirstSessionMessage(name) {
  const session = getSession(name);
  return !session || !session.id || session.message_count === 0;
}

// Auto-generate a short topic name from keywords (no Claude call — saves ~500 tokens)
function autoNameSession(text) {
  const stopWords = new Set(['i','me','my','the','a','an','is','are','was','were','be','been','do','does','did','have','has','had','will','would','could','should','can','may','to','of','in','for','on','with','at','by','from','it','this','that','and','or','but','not','so','if','then','what','how','when','where','who','which','there','here','just','about','up','out','you','your','we','our','they','them','he','she','its','some','any','all','no','yes','ok','please','go','get','let','lets','make','want','need','know','think','look','also','hey','hi','hello','nelson','tell','show','give']);
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
  const name = words.slice(0, 3).join('-') || 'chat-' + Date.now();
  return name.slice(0, 50);
}

// Detect if the user wants to switch to or create a topic session
// Returns { action: 'switch'|'create'|'none', sessionName: string|null }
function detectTopicSwitch(text) {
  const lower = text.toLowerCase().trim();

  // Patterns that indicate switching to an existing topic
  // These must be fairly explicit to avoid false positives on casual messages
  const switchPatterns = [
    /(?:let'?s?\s+)?(?:go\s+)?back\s+to\s+(?:the\s+)?(.+?)(?:\s+(?:topic|session|thing|stuff|work))\s*$/i,
    /(?:let'?s?\s+)?(?:switch|move|change)\s+(?:to|over\s+to)\s+(?:the\s+)?(.+?)(?:\s+(?:topic|session))?\s*$/i,
    /(?:let'?s?\s+)?(?:continue|resume|pick\s+up)\s+(?:with\s+)?(?:the\s+)?(.+?)(?:\s+(?:topic|session|work))\s*$/i,
    /let'?s\s+(?:work\s+on|do)\s+(?:the\s+)?(.+?)(?:\s+(?:again|now))?\s*$/i,
    /(?:let'?s?\s+)?(?:go\s+back\s+to|return\s+to)\s+(?:the\s+)?(.+)/i,
    /^(?:back\s+to|resume)\s+(?:the\s+)?(.+)/i,
  ];

  // Pattern that indicates starting a new topic session
  const newTopicPatterns = [
    /(?:let'?s?\s+)?(?:start|begin|open)\s+(?:a\s+)?(?:new\s+)?(?:topic|session)\s+(?:for|on|about|called)\s+(.+)/i,
    /(?:new\s+topic|new\s+session)\s*[:\-]?\s*(.+)/i,
  ];

  // Check for new topic creation first
  for (const pattern of newTopicPatterns) {
    const match = lower.match(pattern);
    if (match) {
      const topicName = match[1].trim().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 50);
      if (topicName) return { action: 'create', sessionName: topicName };
    }
  }

  // Check for switching to existing topic
  for (const pattern of switchPatterns) {
    const match = lower.match(pattern);
    if (match) {
      const rawTopic = match[1].trim();
      // Try to match against existing session names (fuzzy)
      const data = loadSessions();
      const sessionNames = Object.keys(data.sessions);
      // Exact match
      const normalised = rawTopic.replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
      if (data.sessions[normalised]) return { action: 'switch', sessionName: normalised };
      // Partial match — check if the raw topic is contained in a session name or vice versa
      for (const name of sessionNames) {
        if (name === 'default') continue;
        if (name.includes(normalised) || normalised.includes(name)) {
          return { action: 'switch', sessionName: name };
        }
        // Also match on space-separated version
        const spacedName = name.replace(/-/g, ' ');
        if (rawTopic.includes(spacedName) || spacedName.includes(rawTopic)) {
          return { action: 'switch', sessionName: name };
        }
      }
      // No existing match — create a new session with this name
      if (normalised) return { action: 'create', sessionName: normalised };
    }
  }

  return { action: 'none', sessionName: null };
}

function loadRecentJournals(days = 1) {
  try {
    const files = fs.readdirSync(CONVERSATIONS_DIR)
      .filter(f => f.endsWith('.md'))
      .sort()
      .slice(-days);
    if (files.length === 0) return '';
    // Only load last 1500 chars of today's journal — keeps context tight
    const entries = files.map(f =>
      fs.readFileSync(path.join(CONVERSATIONS_DIR, f), 'utf8').slice(-1500)
    ).join('\n\n');
    return `\n\nRecent conversation journals:\n${entries}`;
  } catch { return ''; }
}

// Download a file from URL to a local path
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    client.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(destPath); });
    }).on('error', (err) => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

// Non-blocking Claude call with progress updates and hard timeout
// sessionName: if provided, uses session mode (--session-id or --resume) instead of --print
function callClaudeAsync(input, { timeout = 300000, onProgress, sessionName, callType = 'message' } = {}) {
  return new Promise((resolve, reject) => {
    // Track usage
    const estimatedInputTokens = Math.round(input.length / 4);
    usage.logCall(callType, estimatedInputTokens);
    // Build args based on session mode
    let args;
    if (sessionName) {
      const session = getSession(sessionName);
      if (session && session.id) {
        // Existing session — resume it
        args = ['--print', '--resume', session.id, '--dangerously-skip-permissions'];
      } else {
        // New session — create with a fresh ID
        const newId = createSession(sessionName);
        args = ['--print', '--session-id', newId, '--dangerously-skip-permissions'];
      }
    } else {
      args = ['--print', '--dangerously-skip-permissions'];
    }

    const proc = spawn(CLAUDE, args, {
      cwd: BASE_DIR,
      env: ENV,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    // Hard timeout — kill if taking too long
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killed) {
        reject(new Error('NELSON_TIMEOUT'));
      } else if (code !== 0 && !stdout.trim()) {
        const errMsg = stderr || stdout || `Process exited with code ${code}`;
        // If session-based call failed, mark for rotation
        if (sessionName && (errMsg.includes('session') || errMsg.includes('context') || errMsg.includes('conversation not found') || code !== 0)) {
          reject(Object.assign(new Error(errMsg), { sessionFailed: true, sessionName }));
        } else {
          reject(new Error(errMsg));
        }
      } else {
        if (sessionName) touchSession(sessionName);
        resolve(stdout);
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Feed input via stdin
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

// updateTopicsInBackground removed — sessions handle topic context natively

/**
 * Wrapped Claude call with hook system, automatic retry, and circuit breaker.
 * Use this instead of raw callClaudeAsync for user-facing calls.
 */
async function callClaudeWithRecovery(input, opts = {}) {
  const { sessionName, callType = 'message' } = opts;
  const context = { input, sessionName, callType, memoryFile: MEMORY_FILE };

  return hooks.execute('claude_call', () => {
    return retryWithBackoff(
      () => callClaudeAsync(input, opts),
      {
        maxRetries: 2,
        baseDelay: 2000,
        maxDelay: 15000,
        shouldRetry: (err) => {
          const type = classifyError(err);
          // Retry on transient errors only — not rate limits or timeouts (those need different handling)
          return type === ERROR_TYPES.NETWORK || type === ERROR_TYPES.UNKNOWN;
        },
        onRetry: (err, attempt, delay) => {
          log.warn('Claude call retry', { attempt: attempt + 1, delayMs: Math.round(delay), err: err.message.slice(0, 100) });
        }
      }
    );
  }, context);
}

function updateMemoryInBackground(text, result, memory) {
  // Use async calls so we don't block the event loop
  (async () => {
    try {
      const prompt = `Update this memory JSON if anything important was said. Return ONLY valid JSON.\nCurrent: ${JSON.stringify(memory)}\nUser: ${text}\nAssistant: ${result}`;
      const update = await callClaudeAsync(prompt, { timeout: 60000, callType: 'memory_update' });
      const jsonMatch = update.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        await hooks.execute('memory_write', () => saveMemoryLocked(parsed), { memoryFile: MEMORY_FILE });
      }
    } catch {}
    try {
      await saveConversationJournalAsync(text, result);
    } catch {}
  })();
}

async function saveConversationJournalAsync(userMsg, assistantMsg) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0].slice(0, 5);
  const journalFile = path.join(CONVERSATIONS_DIR, `${dateStr}.md`);

  try {
    const prompt = `You are writing a conversation journal entry for Nelson (Lorimer's AI agent). Summarise this exchange in 2-4 concise bullet points capturing: what was discussed, any decisions made, any tasks completed, and any insights or opinions shared. Be specific — names, numbers, conclusions. Do NOT use filler. Return ONLY the bullet points, nothing else.

User said: ${userMsg.slice(0, 3000)}

Assistant replied: ${assistantMsg.slice(0, 3000)}`;

    const summary = (await callClaudeAsync(prompt, { timeout: 60000, callType: 'journal' })).trim();

    const entry = `\n### ${timeStr}\n${summary}\n`;

    if (fs.existsSync(journalFile)) {
      fs.appendFileSync(journalFile, entry);
    } else {
      fs.writeFileSync(journalFile, `# Conversation Journal — ${dateStr}\n${entry}`);
    }
  } catch (err) {
    log.error('Journal write failed', { err: err.message });
    logError('journal_write', err.message, `Date: ${dateStr}`);
  }
}

function chunkText(text, maxLen = 4000) {
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.5) splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt < maxLen * 0.5) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

async function sendWithRetry(ctx, text, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      await ctx.reply(text, { parse_mode: 'Markdown' });
      return;
    } catch (err) {
      if (err.description && err.description.includes("can't parse entities")) {
        await ctx.reply(text);
        return;
      }
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 3000));
    }
  }
}

let botInstance = null;

// --- Hook-based recovery strategies ---

// Session corruption: archive the broken session so caller can retry with fresh context
hooks.on('claude_call', 'error', async (err, context) => {
  if (classifyError(err) === ERROR_TYPES.SESSION_CORRUPT && context.sessionName) {
    console.log(`Hook: session "${context.sessionName}" corrupted — archiving for rotation`);
    archiveSession(context.sessionName);
  }
  return null;
});

// Rate limit: log usage hit
hooks.on('claude_call', 'error', async (err, context) => {
  if (classifyError(err) === ERROR_TYPES.RATE_LIMIT) {
    usage.logLimitHit();
    console.log('Hook: rate limit detected, logged usage hit');
  }
  return null;
});

// Memory backup on every successful write
hooks.on('memory_write', 'after', async (result, context) => {
  if (context.memoryFile && fs.existsSync(context.memoryFile)) {
    try {
      fs.copyFileSync(context.memoryFile, context.memoryFile + '.backup');
    } catch (e) {
      console.error('Memory backup failed:', e.message);
    }
  }
});

// Log all claude_call errors for diagnostics
hooks.on('claude_call', 'error', async (err, context) => {
  const type = classifyError(err);
  console.log(`Hook: claude_call error [${type}]: ${err.message.slice(0, 200)}`);
  logError(type, err.message, `callType: ${context.callType || 'unknown'}, session: ${context.sessionName || 'none'}`);
  return null;
});

// --- Command Router Setup ---
const router = new CommandRouter();

// Register all keyword commands
router.command('errors', 'Show today\'s errors', async (ctx, h) => {
  let errors = [];
  try { errors = JSON.parse(fs.readFileSync(ERROR_LOG, 'utf8')); } catch {}
  const today = new Date().toISOString().split('T')[0];
  const todayErrors = errors.filter(e => e.timestamp.startsWith(today));
  if (todayErrors.length === 0) {
    await h.sendReply(ctx, 'No errors today.');
  } else {
    const summary = todayErrors.map((e, i) => {
      const time = e.timestamp.split('T')[1].slice(0, 5);
      let line = `*${i + 1}. ${time}* — \`${e.type}\`\n${e.message.slice(0, 200)}`;
      if (e.diagnosis) line += `\n_Diagnosis:_ ${e.diagnosis.slice(0, 300)}`;
      return line;
    }).join('\n\n');
    const chunks = chunkText(`*Errors today (${todayErrors.length}):*\n\n${summary}`);
    for (const chunk of chunks) await h.sendReply(ctx, chunk);
  }
});

router.command('health', 'Show latest health report', async (ctx, h) => {
  const REPORTS_DIR = path.join(BASE_DIR, 'health_reports');
  const files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md')).sort();
  if (files.length === 0) {
    await h.sendReply(ctx, 'No health reports yet. First one runs at 8am.');
  } else {
    const latest = fs.readFileSync(path.join(REPORTS_DIR, files[files.length - 1]), 'utf8');
    const chunks = chunkText(latest);
    for (const chunk of chunks) await h.sendReply(ctx, chunk);
  }
});

router.command('restart', 'Restart Nelson process', async (ctx, h) => {
  await h.sendReply(ctx, 'Restarting now...').catch(() => {});
  log.info('Restart requested via Telegram');
  releaseLock();
  const child = spawn(process.execPath, [__filename], {
    detached: true, stdio: 'ignore', cwd: BASE_DIR, env: ENV
  });
  child.unref();
  process.exit(0);
});

router.command(['sessions', 'topics'], 'List active sessions', async (ctx, h) => {
  const sessions = listSessions();
  if (sessions.length === 0) {
    await h.sendReply(ctx, 'No sessions yet.');
  } else {
    const lines = sessions.map(s => {
      const active = s.active ? ' ← *active*' : '';
      const msgs = s.message_count || 0;
      const lastUsed = s.last_used ? new Date(s.last_used).toLocaleString('en-GB', { timeZone: 'Europe/London' }) : 'never';
      return `• *${s.name}* — ${msgs} messages, last used: ${lastUsed}${active}`;
    }).join('\n');
    await h.sendReply(ctx, `*Sessions:*\n\n${lines}\n\nSay "back to [topic]" to switch, "new topic: [name]" to create, or "end session" to close the current one.`);
  }
});

router.command('usage', 'Show token usage', async (ctx, h) => {
  await h.sendReply(ctx, usage.formatUsageReport());
});

router.command('hookstatus', 'Show hook system status', async (ctx, h) => {
  const stats = hooks.getStats();
  let msg = '*Hook System Status*\n\n';
  msg += `Calls: ${stats.totalCalls} | Errors: ${stats.totalErrors} | Recoveries: ${stats.totalRecoveries}\n\n`;
  if (Object.keys(stats.errorsByType).length > 0) {
    msg += '*Errors by type:*\n';
    for (const [type, count] of Object.entries(stats.errorsByType)) {
      msg += `• \`${type}\`: ${count}\n`;
    }
    msg += '\n';
  }
  if (Object.keys(stats.circuitBreakers).length > 0) {
    msg += '*Circuit breakers:*\n';
    for (const [name, cb] of Object.entries(stats.circuitBreakers)) {
      const icon = cb.state === 'closed' ? '🟢' : cb.state === 'open' ? '🔴' : '🟡';
      msg += `${icon} \`${name}\`: ${cb.state} (${cb.failures} failures)\n`;
    }
  }
  await h.sendReply(ctx, msg);
});

router.command('memorystats', 'Show memory tier stats', async (ctx, h) => {
  const stats = memoryTiers.getTierStats();
  let msg = '*Memory Tier Stats*\n\n';
  msg += `Full memory: ~${stats.summary.fullMemoryTokens} tokens\n`;
  msg += `Hot tier only: ~${stats.summary.hotOnlyTokens} tokens\n`;
  msg += `Typical savings: ${stats.summary.typicalSavings}\n\n`;
  msg += '*HOT (always included):*\n';
  for (const [key, tokens] of Object.entries(stats.hot)) {
    msg += `  ${key}: ~${tokens} tokens\n`;
  }
  msg += '\n*WARM (when relevant):*\n';
  for (const [name, info] of Object.entries(stats.warm)) {
    msg += `  ${name}: ~${info.tokens} tokens (${info.triggerCount} triggers)\n`;
  }
  msg += '\n*COLD (on demand):*\n';
  for (const [name, info] of Object.entries(stats.cold)) {
    msg += `  ${name}: ~${info.tokens} tokens (${info.triggerCount} triggers)\n`;
  }
  await h.sendReply(ctx, msg);
});

router.command('status', 'Show Nelson status', async (ctx, h) => {
  const uptimeMs = Date.now() - BOOT_TIME;
  const uptimeH = Math.floor(uptimeMs / 3600000);
  const uptimeM = Math.floor((uptimeMs % 3600000) / 60000);
  const memUsage = process.memoryUsage();
  const heapMB = Math.round(memUsage.heapUsed / 1048576);
  const rssMB = Math.round(memUsage.rss / 1048576);
  const sessionsData = loadSessions();
  const sessionCount = Object.keys(sessionsData.sessions).length;
  const hookStats = hooks.getStats();
  const tierStats = memoryTiers.getTierStats();
  const queueStats = messageQueue.getStats();
  let msg = '*Nelson Status*\n\n';
  msg += `⏱ Uptime: ${uptimeH}h ${uptimeM}m\n`;
  msg += `🧠 Memory: ${heapMB}MB heap / ${rssMB}MB RSS\n`;
  msg += `📋 Sessions: ${sessionCount} active\n`;
  msg += `🔗 Hook calls: ${hookStats.totalCalls} (${hookStats.totalErrors} errors, ${hookStats.totalRecoveries} recoveries)\n`;
  msg += `📦 Memory tiers: ${tierStats.summary.hotOnlyTokens} hot tokens, ${tierStats.summary.typicalSavings} savings\n`;
  msg += `📨 Queue: ${queueStats.processed} processed, ${queueStats.dropped} dropped, ${queueStats.timeouts} timeouts\n`;
  msg += `🔄 PID: ${process.pid}\n`;
  const breakers = hookStats.circuitBreakers || {};
  const openBreakers = Object.entries(breakers).filter(([, cb]) => cb.state !== 'closed');
  if (openBreakers.length > 0) {
    msg += '\n⚠️ *Open circuit breakers:*\n';
    for (const [name, cb] of openBreakers) {
      msg += `  🔴 ${name}: ${cb.state} (${cb.failures} failures)\n`;
    }
  } else {
    msg += '\n🟢 All circuit breakers healthy';
  }
  await h.sendReply(ctx, msg);
});

router.command('tasks', 'Show background tasks', async (ctx, h) => {
  const active = tasks.listActiveTasks();
  const recent = tasks.listRecentTasks(5);
  let msg = '*Background Tasks*\n\n';
  if (active.length > 0) {
    msg += '*Running:*\n';
    for (const t of active) {
      const elapsed = Math.round((Date.now() - new Date(t.started_at).getTime()) / 60000);
      msg += `• \`${t.id}\` — ${t.description} (${elapsed}m)\n`;
    }
  } else {
    msg += 'No tasks running.\n';
  }
  if (recent.length > 0) {
    msg += '\n*Recent:*\n';
    for (const t of recent) {
      const icon = t.status === 'completed' ? '✅' : t.status === 'timeout' ? '⏱' : '❌';
      msg += `${icon} ${t.description}\n`;
    }
  }
  await h.sendReply(ctx, msg);
});

router.command('help', 'Show available commands', async (ctx, h) => {
  const cmds = router.listCommands();
  let msg = '*Nelson Commands*\n\n';
  for (const { keywords, description } of cmds) {
    msg += `• *${keywords[0]}* — ${description}\n`;
  }
  msg += '\n*Routing:*\n';
  msg += '• *@dev [task]* — send to Nelson Dev\n';
  msg += '• *@dev [N] hours building [X]* — sprint build\n';
  msg += '• *go [task]* — background task\n';
  msg += '\n*Session:*\n';
  msg += '• *new topic: [name]* — start a topic\n';
  msg += '• *back to [topic]* — switch topic\n';
  msg += '• *end session* — close current topic\n';
  await h.sendReply(ctx, msg);
});

router.command(['end session', 'close session'], 'Close current session', async (ctx, h) => {
  const data = loadSessions();
  const current = data.active_session;
  if (current) {
    data.active_session = null;
    saveSessions(data);
    await h.sendReply(ctx, `Session "${current}" closed. Next message will start a new topic.`);
    const history = loadHistory();
    const recentExchanges = history.slice(-10).map(m => `${m.role}: ${m.text}`).join('\n');
    if (recentExchanges.length > 50) {
      setImmediate(() => updateMemoryInBackground(recentExchanges, '', loadMemory()));
    }
  } else {
    await h.sendReply(ctx, 'No active session. Next message will start a new topic.');
  }
});

// Pattern: cancel task
router.pattern(/^cancel\s+task\s+(\S+)/i, 'Cancel a background task', async (ctx, h, match) => {
  const taskId = match[1];
  if (tasks.cancelTask(taskId)) {
    await h.sendReply(ctx, `Task \`${taskId}\` cancelled.`);
  } else {
    await h.sendReply(ctx, `No active task with ID \`${taskId}\`.`);
  }
});

// Pattern: @dev routing
router.pattern(/^@dev\s+(.+)/i, 'Dev task routing', async (ctx, h, match) => {
  const devTask = match[1].trim();
  const sendResult = (message) => {
    const chunks = chunkText(message);
    for (const chunk of chunks) {
      botInstance.telegram.sendMessage(ALLOWED_USER_ID, chunk, { parse_mode: 'Markdown' }).catch(() => {
        botInstance.telegram.sendMessage(ALLOWED_USER_ID, chunk.replace(/[*_`]/g, '')).catch(() => {});
      });
    }
  };

  // Check for sprint builds: "@dev spend 8 hours building X"
  const sprintMatch = devTask.match(/(?:spend\s+)?(\d+)\s*(?:hours?|hrs?)\s+(?:building|creating|making|on)\s+(.+)/i);
  if (sprintMatch) {
    const hours = parseInt(sprintMatch[1]);
    const projectDesc = sprintMatch[2].trim();
    const projectName = projectDesc.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).slice(0, 3).join('-') || 'project';
    const projectDir = path.join(process.env.HOME, 'projects', projectName);
    const result = tasks.launchSprintTask(projectDesc, projectDir, { sendResult, sprintMinutes: 30, totalHours: hours });
    return;
  }

  const memory = loadMemory();
  const context = `User memory summary: ${JSON.stringify(memory.core || {})}\nBrowser: node ~/nelson/nelson/lib/browse.js goto/screenshot/click/type/text/close\nProjects dir: ~/projects/`;
  const result = tasks.launchTask(devTask, context, { sendResult, role: 'dev' });
  if (result.blocked) return;
  await h.sendReply(ctx, `🛠 *Nelson Dev* task launched: _${result.description}_\n\nID: \`${result.taskId}\`\nI'll message you when it's done.\n\nSend "tasks" to check status.`);
});

// Pattern: background task requests
router.pattern(/^(?:go|please go|nelson go)\s+(.+)/i, 'Background task', async (ctx, h, match) => {
  await h.launchBgTask(ctx, match[1].trim());
});
router.pattern(/^(?:background|bg|task)[:\s]+(.+)/i, 'Background task', async (ctx, h, match) => {
  await h.launchBgTask(ctx, match[1].trim());
});
router.pattern(/^(?:in the background)[,:\s]+(.+)/i, 'Background task', async (ctx, h, match) => {
  await h.launchBgTask(ctx, match[1].trim());
});
router.pattern(/^(?:autonomously|independently)[,:\s]+(.+)/i, 'Background task', async (ctx, h, match) => {
  await h.launchBgTask(ctx, match[1].trim());
});

// Pattern: reboot
const rebootKeywords = ['reboot', 'reboot the mac', 'full restart', 'restart the mac', 'restart mac mini', 'reboot mac mini', 'hard reset', 'do a reboot', 'do a full restart'];
router.pattern(new RegExp(`(?:${rebootKeywords.map(k => k.replace(/\s+/g, '\\s+')).join('|')})`, 'i'), 'Reboot Mac Mini', async (ctx, h) => {
  const REBOOT_SECONDS = 90;
  const returnTime = new Date(Date.now() + REBOOT_SECONDS * 1000);
  const timeStr = returnTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Europe/London' });
  await h.sendReply(ctx, `Rebooting the Mac Mini now. I should be back by ${timeStr} (~${REBOOT_SECONDS}s). See you on the other side.`).catch(() => {});
  log.warn('Full reboot requested via Telegram');
  releaseLock();
  spawn('sudo', ['/sbin/reboot'], { detached: true, stdio: 'ignore' });
  process.exit(0);
});

function startBot() {
  const bot = new Telegraf(TOKEN, { telegram: { timeout: 60000 } });
  botInstance = bot;

  bot.catch((err) => {
    const msg = err.message || '';
    // Ignore benign polling timeouts — Telegraf retries automatically
    if (msg.includes('timed out') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET') || msg.includes('network socket disconnected')) {
      log.info('Transient network error (ignored)', { err: msg });
      return;
    }
    log.error('Bot framework error', { err: msg });
    logError('bot_framework', msg, err.stack ? err.stack.slice(0, 500) : '', true);
  });

  // --- Photo handler ---
  // --- Voice message handler ---
  bot.on('voice', async (ctx) => {
    if (ctx.from.id !== ALLOWED_USER_ID) return;
    const msgId = ctx.message.message_id;
    if (ctx.message.date < BOT_START_TIME) return;
    if (processedMessages.has(msgId)) return;
    processedMessages.set(msgId, Date.now());

    const queued = messageQueue.enqueue(async () => {
      const typingInterval = setInterval(() => {
        ctx.telegram.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
      }, 5000);

      try {
        const voice = ctx.message.voice;
        const fileLink = await ctx.telegram.getFileLink(voice.file_id);
        const tmpPath = path.join(os.tmpdir(), `nelson_voice_${msgId}.ogg`);
        await downloadFile(fileLink.href, tmpPath);

        const memory = loadMemory();
        const sessionsData = loadSessions();
        let activeSessionName = sessionsData.active_session;
        if (!activeSessionName) {
          activeSessionName = 'voice-message';
          setActiveSession(activeSessionName);
        }

        const duration = voice.duration || 0;
        let voicePrompt;
        if (isFirstSessionMessage(activeSessionName)) {
          const history = loadHistory();
          const historyBlock = history.length > 0
            ? `\n\nRecent conversation:\n${history.map(m => `${m.role}: ${m.text}`).join('\n')}`
            : '';
          const journalBlock = loadRecentJournals();
          const tiered = memoryTiers.selectMemory('voice message');
          voicePrompt = `Here is your memory of the user:\n${memoryTiers.formatForPrompt(tiered.memory)}${journalBlock}${historyBlock}\n\nLorimer sent a voice message (${duration}s). The audio file is at: ${tmpPath}\nPlease read/transcribe the audio file and respond to what he said.`;
        } else {
          voicePrompt = `Lorimer sent a voice message (${duration}s). The audio file is at: ${tmpPath}\nPlease read/transcribe the audio file and respond to what he said.`;
        }

        const result = await callClaudeWithRecovery(voicePrompt, { timeout: 300000, sessionName: activeSessionName });
        clearInterval(typingInterval);
        addToHistory('User', '[Voice message]');
        addToHistory('Assistant', result);
        const chunks = chunkText(result);
        for (const chunk of chunks) await sendWithRetry(ctx, chunk);
        try { fs.unlinkSync(tmpPath); } catch {}
      } catch (err) {
        clearInterval(typingInterval);
        log.error('Voice handler error', { err: err.message });
        logError('voice_handler', err.message, '', true);
        try { await sendWithRetry(ctx, 'Had trouble with that voice message. Try again or type it out?'); } catch {}
      }
    }, { msgId, type: 'voice' });

    if (!queued) {
      await sendWithRetry(ctx, 'Too many messages queued — give me a moment.').catch(() => {});
    }
  });

  // --- Document handler ---
  bot.on('document', async (ctx) => {
    if (ctx.from.id !== ALLOWED_USER_ID) return;
    const msgId = ctx.message.message_id;
    if (ctx.message.date < BOT_START_TIME) return;
    if (processedMessages.has(msgId)) return;
    processedMessages.set(msgId, Date.now());

    const queued = messageQueue.enqueue(async () => {
      const caption = ctx.message.caption || '';
      const typingInterval = setInterval(() => {
        ctx.telegram.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
      }, 5000);

      try {
        const doc = ctx.message.document;
        const fileName = doc.file_name || 'unknown';
        const fileSize = doc.file_size || 0;

        // Skip files over 10MB
        if (fileSize > 10 * 1024 * 1024) {
          clearInterval(typingInterval);
          await sendWithRetry(ctx, 'That file is too large (>10MB). Send something smaller or paste the contents.');
          return;
        }

        const fileLink = await ctx.telegram.getFileLink(doc.file_id);
        const ext = path.extname(fileName) || '';
        const tmpPath = path.join(os.tmpdir(), `nelson_doc_${msgId}${ext}`);
        await downloadFile(fileLink.href, tmpPath);

        const sessionsData = loadSessions();
        let activeSessionName = sessionsData.active_session;
        if (!activeSessionName) {
          activeSessionName = autoNameSession(caption || fileName);
          setActiveSession(activeSessionName);
        }

        let docPrompt;
        if (isFirstSessionMessage(activeSessionName)) {
          const history = loadHistory();
          const historyBlock = history.length > 0
            ? `\n\nRecent conversation:\n${history.map(m => `${m.role}: ${m.text}`).join('\n')}`
            : '';
          const journalBlock = loadRecentJournals();
          const tiered = memoryTiers.selectMemory(caption || fileName);
          docPrompt = `Here is your memory of the user:\n${memoryTiers.formatForPrompt(tiered.memory)}${journalBlock}${historyBlock}\n\nLorimer sent a file: "${fileName}" (${Math.round(fileSize / 1024)}KB). It's saved at: ${tmpPath}\nPlease read/analyse the file and respond.${caption ? `\nCaption: ${caption}` : ''}`;
        } else {
          docPrompt = `Lorimer sent a file: "${fileName}" (${Math.round(fileSize / 1024)}KB). It's saved at: ${tmpPath}\nPlease read/analyse the file and respond.${caption ? `\nCaption: ${caption}` : ''}`;
        }

        const result = await callClaudeWithRecovery(docPrompt, { timeout: 300000, sessionName: activeSessionName });
        clearInterval(typingInterval);
        addToHistory('User', `[File: ${fileName}]${caption ? ` ${caption}` : ''}`);
        addToHistory('Assistant', result);
        const chunks = chunkText(result);
        for (const chunk of chunks) await sendWithRetry(ctx, chunk);
        try { fs.unlinkSync(tmpPath); } catch {}
      } catch (err) {
        clearInterval(typingInterval);
        log.error('Document handler error', { err: err.message });
        logError('document_handler', err.message, '', true);
        try { await sendWithRetry(ctx, 'Had trouble with that file. Try again?'); } catch {}
      }
    }, { msgId, type: 'document' });

    if (!queued) {
      await sendWithRetry(ctx, 'Too many messages queued — give me a moment.').catch(() => {});
    }
  });

  // --- Sticker handler ---
  bot.on('sticker', async (ctx) => {
    if (ctx.from.id !== ALLOWED_USER_ID) return;
    const msgId = ctx.message.message_id;
    if (ctx.message.date < BOT_START_TIME) return;
    if (processedMessages.has(msgId)) return;
    processedMessages.set(msgId, Date.now());
    // Just acknowledge stickers — don't waste tokens
    const emoji = ctx.message.sticker.emoji || '🤷';
    log.debug('Sticker received', { emoji, msgId });
  });

  // --- Photo handler ---
  bot.on('photo', async (ctx) => {
    if (ctx.from.id !== ALLOWED_USER_ID) return;
    const msgId = ctx.message.message_id;
    if (ctx.message.date < BOT_START_TIME) return;
    if (processedMessages.has(msgId)) return;
    processedMessages.set(msgId, Date.now());

    const queued = messageQueue.enqueue(async () => {
      const caption = ctx.message.caption || '';
      let replyContext = '';
      if (ctx.message.reply_to_message) {
        const orig = ctx.message.reply_to_message;
        const origText = orig.text || orig.caption || '[non-text message]';
        replyContext = `\n\n[Lorimer is replying to this earlier message: "${origText.slice(0, 1000)}"]`;
      }

      const typingInterval = setInterval(() => {
        ctx.telegram.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
      }, 5000);

      try {
        const photos = ctx.message.photo;
        const best = photos[photos.length - 1];
        const fileLink = await ctx.telegram.getFileLink(best.file_id);
        const tmpPath = path.join(os.tmpdir(), `nelson_photo_${msgId}.jpg`);
        await downloadFile(fileLink.href, tmpPath);

        const memory = loadMemory();
        const sessionsData = loadSessions();
        let activeSessionName = sessionsData.active_session;
        if (!activeSessionName) {
          activeSessionName = await autoNameSession(caption || 'photo-analysis');
          setActiveSession(activeSessionName);
        }

        let imagePrompt;
        if (isFirstSessionMessage(activeSessionName)) {
          const history = loadHistory();
          const historyBlock = history.length > 0
            ? `\n\nRecent conversation:\n${history.map(m => `${m.role}: ${m.text}`).join('\n')}`
            : '';
          const journalBlock = loadRecentJournals();
          const photoMemory = memoryTiers.selectMemory(caption || 'photo');
          imagePrompt = `Here is your memory of the user:\n${memoryTiers.formatForPrompt(photoMemory.memory)}${journalBlock}${historyBlock}${replyContext}\n\nLorimer sent a photo. The image is saved at: ${tmpPath}\nPlease read the image file at that path to see what it contains.\n${caption ? `Caption: ${caption}` : 'No caption provided.'}\n\nRespond naturally based on what you see in the image${caption ? ' and the caption' : ''}.`;
        } else {
          imagePrompt = `${replyContext}\n\nLorimer sent a photo. The image is saved at: ${tmpPath}\nPlease read the image file at that path to see what it contains.\n${caption ? `Caption: ${caption}` : 'No caption provided.'}\n\nRespond naturally based on what you see in the image${caption ? ' and the caption' : ''}.`;
        }

        const result = await callClaudeWithRecovery(imagePrompt, { timeout: 300000, sessionName: activeSessionName });
        clearInterval(typingInterval);
        addToHistory('User', `[Photo]${caption ? ` ${caption}` : ''}`);
        addToHistory('Assistant', result);
        const chunks = chunkText(result);
        for (const chunk of chunks) await sendWithRetry(ctx, chunk);
        try { fs.unlinkSync(tmpPath); } catch {}
      } catch (err) {
        clearInterval(typingInterval);
        log.error('Photo handler error', { err: err.message });
        logError('photo_handler', err.message, '', true);
        try { await sendWithRetry(ctx, 'Had trouble processing that image. Try again?'); } catch {}
      }
    }, { msgId, type: 'photo' });

    if (!queued) {
      await sendWithRetry(ctx, 'Too many messages queued — give me a moment.').catch(() => {});
    }
  });

  // --- Reaction handler (silent — just log, don't spam back) ---
  bot.on('message_reaction', async (ctx) => {
    try {
      const update = ctx.update.message_reaction;
      if (!update) return;
      const userId = update.user?.id || ctx.from?.id || update.actor_chat?.id;
      if (userId !== ALLOWED_USER_ID) return;
      const newEmojis = (update.new_reaction || [])
        .map(r => r.emoji || r.custom_emoji_id || '?')
        .join(' ');
      if (!newEmojis) return;
      log.debug('Reaction received', { emojis: newEmojis });
    } catch (err) {
      log.warn('Reaction handler error', { err: err.message });
    }
  });

  bot.on('text', async (ctx) => {
    if (ctx.from.id !== ALLOWED_USER_ID) return;
    const msgId = ctx.message.message_id;
    if (ctx.message.date < BOT_START_TIME) return;
    if (processedMessages.has(msgId)) return;
    processedMessages.set(msgId, Date.now());
    // Prune old message IDs (older than 10 minutes)
    const DEDUP_TTL = 10 * 60 * 1000;
    if (processedMessages.size > 100) {
      const cutoff = Date.now() - DEDUP_TTL;
      for (const [id, ts] of processedMessages) {
        if (ts < cutoff) processedMessages.delete(id);
      }
    }
    const text = ctx.message.text;
    const reqId = log.requestId();
    const reqLog = log.child({ requestId: reqId, msgId, component: 'handler' });
    reqLog.info('message received', { text: text.slice(0, 100) });

    // Shared helpers passed to all command handlers
    const helpers = {
      sendReply: sendWithRetry,
      chunkText,
      loadMemory,
      loadHistory,
      loadSessions,
      saveSessions,
      setActiveSession,
      getSession,
      archiveSession,
      isFirstSessionMessage,
      autoNameSession,
      detectTopicSwitch,
      loadRecentJournals,
      memoryTiers,
      callClaudeWithRecovery,
      callClaudeAsync,
      addToHistory,
      updateMemoryInBackground,
      touchActivity,
      logError,
      launchBgTask: async (bgCtx, bgText) => {
        const memory = loadMemory();
        const context = `User memory summary: ${JSON.stringify(memory.core || {})}\nBrowser: node ~/nelson/nelson/lib/browse.js goto/screenshot/click/type/text/close`;
        const sendResult = (message) => {
          const chunks = chunkText(message);
          for (const chunk of chunks) {
            botInstance.telegram.sendMessage(ALLOWED_USER_ID, chunk, { parse_mode: 'Markdown' }).catch(() => {
              botInstance.telegram.sendMessage(ALLOWED_USER_ID, chunk.replace(/[*_`]/g, '')).catch(() => {});
            });
          }
        };
        const result = tasks.launchTask(bgText, context, { sendResult, role: 'general' });
        if (result.blocked) return;
        await sendWithRetry(bgCtx, `🚀 Task launched: _${result.description}_\n\nID: \`${result.taskId}\`\nI'll message you when it's done.\n\nSend "tasks" to check status.`);
      },
    };

    // Try command router first — handles all keyword and pattern commands
    const handled = await router.handle(ctx, text, helpers);
    if (handled) return;

    // Not a command — queue for Claude conversation processing
    const queued = messageQueue.enqueue(async () => {
      let repliedSuccessfully = false;
      try {
        touchActivity();

        const typingInterval = setInterval(() => {
          ctx.telegram.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
        }, 5000);

        let progressSent = false;
        const progressTimer = setTimeout(async () => {
          progressSent = true;
          await sendWithRetry(ctx, 'Still thinking on this one...').catch(() => {});
        }, 30000);

        let prompt;
        let activeSessionName;

        try {
          const history = loadHistory().slice(-5);
          const historyBlock = history.length > 0
            ? `\n\nRecent conversation:\n${history.map(m => `${m.role}: ${m.text.slice(0, 300)}`).join('\n')}`
            : '';
          const journalBlock = loadRecentJournals();
          let replyContext = '';
          if (ctx.message.reply_to_message) {
            const orig = ctx.message.reply_to_message;
            const origText = orig.text || orig.caption || '[non-text message]';
            replyContext = `\n\n[Lorimer is replying to this earlier message: "${origText.slice(0, 1000)}"]`;
          }
          const topicSwitch = detectTopicSwitch(text);
          let topicSwitchNotice = '';

          if (topicSwitch.action === 'switch') {
            setActiveSession(topicSwitch.sessionName);
            activeSessionName = topicSwitch.sessionName;
            topicSwitchNotice = `\n\n[Session switched to: "${topicSwitch.sessionName}" — resuming previous context for this topic]`;
          } else if (topicSwitch.action === 'create') {
            activeSessionName = topicSwitch.sessionName;
            setActiveSession(activeSessionName);
            topicSwitchNotice = `\n\n[New topic session created: "${topicSwitch.sessionName}"]`;
          } else {
            const sessionsData = loadSessions();
            activeSessionName = sessionsData.active_session;
            if (!activeSessionName) {
              activeSessionName = await autoNameSession(text);
              setActiveSession(activeSessionName);
              topicSwitchNotice = `\n\n[New topic session created: "${activeSessionName}"]`;
            }
          }

          if (isFirstSessionMessage(activeSessionName)) {
            const tiered = memoryTiers.selectMemory(text);
            log.info('memory tiers selected', { tiers: tiered.tiers, tokenEstimate: tiered.tokenEstimate });
            prompt = `Here is your memory of the user:\n${memoryTiers.formatForPrompt(tiered.memory)}${journalBlock}${historyBlock}${replyContext}${topicSwitchNotice}\n\nUser says: ${text}`;
          } else {
            prompt = `${replyContext}${topicSwitchNotice}\n\nUser says: ${text}`;
          }

          let result;
          try {
            result = await callClaudeWithRecovery(prompt, { timeout: 300000, sessionName: activeSessionName });
          } catch (retryErr) {
            if (retryErr.sessionFailed || classifyError(retryErr) === ERROR_TYPES.SESSION_CORRUPT) {
              console.log(`Session "${activeSessionName}" failed — retrying with fresh context`);
              const freshTiered = memoryTiers.selectMemory(text, { full: true });
              const freshPrompt = `Here is your memory of the user:\n${memoryTiers.formatForPrompt(freshTiered.memory)}${journalBlock}${historyBlock}${replyContext}${topicSwitchNotice}\n\nUser says: ${text}`;
              result = await callClaudeWithRecovery(freshPrompt, { timeout: 300000, sessionName: activeSessionName });
            } else {
              throw retryErr;
            }
          }
          clearTimeout(progressTimer);
          clearInterval(typingInterval);
          addToHistory('User', text);
          addToHistory('Assistant', result);
          const chunks = chunkText(result);
          for (const chunk of chunks) await sendWithRetry(ctx, chunk);
          const warning = usage.getWarningMessage();
          if (warning) await sendWithRetry(ctx, warning).catch(() => {});
          repliedSuccessfully = true;
          touchActivity();
          // Auto-rotate session at 15 messages
          const currentSession = getSession(activeSessionName);
          if (currentSession && currentSession.message_count >= 15) {
            archiveSession(activeSessionName);
            const data = loadSessions();
            data.active_session = null;
            saveSessions(data);
            log.info('Session auto-rotated', { session: activeSessionName, messages: currentSession.message_count });
          }
        } catch (err) {
          clearTimeout(progressTimer);
          touchActivity();
          clearInterval(typingInterval);
          const errorType = classifyError(err);
          let reply;
          if (errorType === ERROR_TYPES.TIMEOUT) {
            reply = 'That was too complex — I hit my time limit. Try breaking it into a simpler question.';
          } else if (errorType === ERROR_TYPES.RATE_LIMIT) {
            usage.logLimitHit();
            if (prompt && activeSessionName) {
              await sendWithRetry(ctx, '⏸️ Token limit hit. Waiting 5 minutes then retrying automatically...').catch(() => {});
              await new Promise(r => setTimeout(r, 5 * 60 * 1000));
              try {
                const retryResult = await callClaudeWithRecovery(prompt, { timeout: 300000, sessionName: activeSessionName });
                addToHistory('User', text);
                addToHistory('Assistant', retryResult);
                const retryChunks = chunkText(retryResult);
                for (const chunk of retryChunks) await sendWithRetry(ctx, chunk);
                repliedSuccessfully = true;
                touchActivity();
                return;
              } catch (retryErr2) {
                await sendWithRetry(ctx, '⏸️ Still limited. Waiting 15 more minutes...').catch(() => {});
                await new Promise(r => setTimeout(r, 15 * 60 * 1000));
                try {
                  const retry2Result = await callClaudeWithRecovery(prompt, { timeout: 300000, sessionName: activeSessionName });
                  addToHistory('User', text);
                  addToHistory('Assistant', retry2Result);
                  const retry2Chunks = chunkText(retry2Result);
                  for (const chunk of retry2Chunks) await sendWithRetry(ctx, chunk);
                  repliedSuccessfully = true;
                  touchActivity();
                  return;
                } catch {
                  // Give up after two retries
                }
              }
            }
            reply = 'Token limit still active after retrying. I\'ll be back once it fully resets.';
          } else if (errorType === ERROR_TYPES.NETWORK) {
            reply = 'Network issue — try again in a moment.';
          } else if (errorType === ERROR_TYPES.SESSION_CORRUPT) {
            reply = 'Session had an issue — it\'s been rotated. Try again.';
          } else if (err.circuitOpen) {
            reply = 'Too many recent failures — I\'m cooling down. Try again in a couple of minutes.';
          } else {
            reply = 'Something went wrong — try again in a moment.';
            logError('unhandled_response', err.message, `User message: ${text.slice(0, 200)}`, true);
          }
          try {
            await sendWithRetry(ctx, reply);
            repliedSuccessfully = true;
          } catch {
            try {
              await ctx.reply(reply);
              repliedSuccessfully = true;
            } catch (finalErr) {
              log.fatal('Failed to send ANY reply', { err: finalErr.message });
              logError('reply_failure', finalErr.message, `Reply was: ${reply}`);
            }
          }
        }
      } catch (outerErr) {
        log.error('Top-level handler crash', { err: outerErr.message });
        logError('handler_crash', outerErr.message, outerErr.stack ? outerErr.stack.slice(0, 500) : '', true);
        if (!repliedSuccessfully) {
          try { await ctx.reply('Something went wrong internally. Try again or send "restart" if I seem stuck.'); } catch {}
        }
      }
    }, { msgId, type: 'text', text: text.slice(0, 50) });

    if (!queued) {
      await sendWithRetry(ctx, 'Too many messages queued — give me a moment to catch up.').catch(() => {});
    }
  });


  // Log all raw updates for debugging
  bot.use((ctx, next) => {
    const updateType = Object.keys(ctx.update).filter(k => k !== 'update_id').join(', ');
    log.debug('Update received', { type: updateType });
    return next();
  });

  bot.launch({
    allowedUpdates: ['message', 'message_reaction', 'message_reaction_count', 'callback_query']
  }).then(() => {
    log.info('Nelson is live');
    bot.telegram.sendMessage(ALLOWED_USER_ID, 'Nelson is online.').catch(() => {});
  }).catch(err => {
    log.error('Bot launch failed', { err: err.message });
    // 409 = another instance still connected — wait longer for Telegram to release
    const delay = err.message.includes('409') ? 60000 : 30000;
    log.info('Retrying bot launch', { delayMs: delay });
    setTimeout(startBot, delay);
  });

  process.once('SIGINT', () => gracefulShutdown('SIGINT'));
  process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

// Graceful shutdown handler — logs uptime and cleans up
function gracefulShutdown(signal) {
  const uptimeMs = Date.now() - BOOT_TIME;
  const uptimeMin = Math.round(uptimeMs / 60000);
  log.info('Shutting down', { signal, uptimeMinutes: uptimeMin, pid: process.pid });
  releaseLock();
  if (botInstance) {
    try { botInstance.stop(signal); } catch {}
  }
  process.exit(0);
}

process.on('uncaughtException', (err) => {
  log.fatal('Uncaught exception', { err: err.message });
  logError('uncaughtException', err.message, err.stack ? err.stack.slice(0, 500) : '', true);
});

process.on('unhandledRejection', (err) => {
  log.fatal('Unhandled rejection', { err: String(err) });
  logError('unhandledRejection', String(err), err && err.stack ? err.stack.slice(0, 500) : '', true);
});

// Log rotation — keep nelson.log under 5MB, retain 2 old copies
function rotateLogIfNeeded() {
  log.rotateIfNeeded();
}

// Daily health check — runs at 8am UK time
function scheduleDailyHealthCheck() {
  function msUntilNext8am() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(8, 0, 0, 0);
    if (now >= next) next.setDate(next.getDate() + 1);
    return next - now;
  }

  async function runHealthCheck() {
    const today = new Date().toISOString().split('T')[0];
    log.info('Running daily health check', { date: today });

    // Rotate log if oversized
    rotateLogIfNeeded();

    const REPORTS_DIR = path.join(BASE_DIR, 'health_reports');
    if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR);

    let errors = [];
    try { errors = JSON.parse(fs.readFileSync(ERROR_LOG, 'utf8')); } catch {}
    const unresolvedErrors = errors.filter(e => !e.resolved);

    // Check package.json dependencies vs node_modules
    let depCheck = 'OK';
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'package.json'), 'utf8'));
      const deps = Object.keys(pkg.dependencies || {});
      const missing = deps.filter(d => !fs.existsSync(path.join(BASE_DIR, 'node_modules', d)));
      if (missing.length > 0) depCheck = `Missing: ${missing.join(', ')}`;
    } catch {}

    // Check crontab
    let crontab = '';
    try { crontab = execSync('crontab -l 2>/dev/null', { encoding: 'utf8' }); } catch {}

    // Check process health
    let processInfo = '';
    try { processInfo = execSync('ps aux | grep "node nelson.js" | grep -v grep', { encoding: 'utf8' }); } catch {}

    // Phase 1: Lightweight diagnose — only errors + system status (no full file dumps)
    const diagnosePrompt = `You are Nelson's daily health check. Today is ${today}. Produce a brief health report.

## Unresolved Errors (${unresolvedErrors.length})
${unresolvedErrors.length > 0 ? JSON.stringify(unresolvedErrors.slice(-10), null, 2) : 'None'}

## System Status
- Dependencies: ${depCheck}
- Process: ${processInfo ? 'Running' : 'NOT FOUND'}
- Crontab entries: ${crontab.split('\n').filter(l => l.trim()).length}

## Hook System
${JSON.stringify(hooks.getStats(), null, 2)}

Report:
1. For each error: one-line cause and fix
2. Any system issues
3. Overall status: HEALTHY or NEEDS_ATTENTION

Keep it under 500 words. Only flag real issues.`;

    let report = '';
    let fixesApplied = [];

    try {
      report = await callClaudeAsync(diagnosePrompt, { timeout: 300000, callType: 'health_check' });
      const reportFile = path.join(REPORTS_DIR, `${today}.md`);
      fs.writeFileSync(reportFile, `# Daily Health Report — ${today}\n\n${report}`);
      log.info('Health report saved', { file: reportFile });
    } catch (err) {
      log.error('Health check diagnosis failed', { err: err.message });
      logError('health_check', err.message, 'Health check diagnosis phase failed');
      setTimeout(runHealthCheck, msUntilNext8am());
      return;
    }

    // Auto-fix phase removed — saves ~50k tokens. Issues flagged to Lorimer instead.

    // Mark errors as reviewed
    errors.forEach(e => {
      if (!e.reviewed) e.reviewed = today;
    });
    fs.writeFileSync(ERROR_LOG, JSON.stringify(errors, null, 2));

    // Send summary to Lorimer
    if (botInstance && ALLOWED_USER_ID) {
      let summary = `*Daily Health Check — ${today}*\n\n`;
      if (unresolvedErrors.length === 0) {
        summary += `No unresolved errors. All systems healthy.\n`;
      } else {
        summary += `${unresolvedErrors.length} unresolved error(s). Say "health" for details.\n`;
      }

      botInstance.telegram.sendMessage(ALLOWED_USER_ID, summary, { parse_mode: 'Markdown' }).catch(() => {
        botInstance.telegram.sendMessage(ALLOWED_USER_ID, summary.replace(/[*_`]/g, '')).catch(() => {});
      });
    }

    // Schedule next run
    setTimeout(runHealthCheck, msUntilNext8am());
  }

  setTimeout(runHealthCheck, msUntilNext8am());
}

// Watchdog — track last activity, auto-restart if stuck
let lastActivityTime = Date.now();
function touchActivity() { lastActivityTime = Date.now(); }

function startWatchdog() {
  setInterval(() => {
    // Write heartbeat so external watchdog can verify we're alive
    const watchdogFile = path.join(BASE_DIR, 'watchdog.txt');
    const uptimeMs = Date.now() - BOOT_TIME;
    fs.writeFileSync(watchdogFile, `${Date.now()}\n${process.pid}\n${uptimeMs}`);
  }, 60000); // Write heartbeat every minute

  // Periodic log rotation — every 6 hours
  setInterval(() => {
    log.rotateIfNeeded();
  }, 6 * 3600000);
}

// Daily updater — runs at 9am UK time, suggests improvements
function scheduleDailyUpdater() {
  function msUntilNext9am() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(9, 0, 0, 0);
    if (now >= next) next.setDate(next.getDate() + 1);
    return next - now;
  }

  function runUpdater() {
    log.info('Running daily updater');
    const sendResult = (message) => {
      if (botInstance && ALLOWED_USER_ID) {
        const chunks = chunkText(message);
        for (const chunk of chunks) {
          botInstance.telegram.sendMessage(ALLOWED_USER_ID, chunk, { parse_mode: 'Markdown' }).catch(() => {
            botInstance.telegram.sendMessage(ALLOWED_USER_ID, chunk.replace(/[*_`]/g, '')).catch(() => {});
          });
        }
      }
    };
    tasks.launchTask(
      'Daily Nelson self-improvement scan',
      `Do these three things, then produce a single report:

1. CODEBASE: Read ~/nelson/nelson/ (nelson.js, lib/, roles/). Spot bugs, inefficiencies, missing features.

2. LIFE CONTEXT: Read Lorimer's memory file (~/nelson/nelson/memory.json), recent conversation journals (~/.claude/projects/-Users-nelson-nelson/memory/conversations/), and check his recent emails and calendar. What's he working on? What would help him right now?

3. ECOSYSTEM: Search the web for latest Claude Code updates and personal AI agent techniques relevant to Nelson.

Produce a Telegram report: max 5 suggestions ranked by impact. Each needs: What (one line), Why (reference his actual life/work where relevant), Effort (small/medium/large). Do NOT make any changes.`,
      { sendResult, role: 'updater', timeout: 300000 }
    );
    setTimeout(runUpdater, msUntilNext9am());
  }

  setTimeout(runUpdater, msUntilNext9am());
}

// Daily life sync — runs at 7am UK time, refreshes memory from Gmail/Calendar/journals
function scheduleDailyLifeSync() {
  function msUntilNext7am() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(7, 0, 0, 0);
    if (now >= next) next.setDate(next.getDate() + 1);
    return next - now;
  }

  function runLifeSync() {
    log.info('Running daily life sync');
    const sendResult = (message) => {
      // The result should be updated memory JSON — save it
      try {
        const jsonMatch = message.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const updated = JSON.parse(jsonMatch[0]);
          if (updated.core && updated.core.name) {
            saveMemory(updated);
            log.info('Life sync: memory.json updated');
            if (botInstance && ALLOWED_USER_ID) {
              const summary = updated.life_context
                ? `🔄 *Memory synced*\n\n${updated.life_context.week_summary || 'Updated.'}\n${updated.life_context.urgent ? `\n⚠️ *Urgent:* ${updated.life_context.urgent}` : ''}`
                : '🔄 Memory synced.';
              botInstance.telegram.sendMessage(ALLOWED_USER_ID, summary, { parse_mode: 'Markdown' }).catch(() => {
                botInstance.telegram.sendMessage(ALLOWED_USER_ID, summary.replace(/[*_`]/g, '')).catch(() => {});
              });
            }
          }
        }
      } catch (err) {
        log.error('Life sync parse failed', { err: err.message });
        if (botInstance && ALLOWED_USER_ID) {
          botInstance.telegram.sendMessage(ALLOWED_USER_ID, '🔄 Life sync ran but failed to update memory. Check logs.').catch(() => {});
        }
      }
    };
    tasks.launchTask(
      'Daily life sync — refresh memory from Gmail, Calendar, and conversations',
      `Read the current memory.json from ~/nelson/nelson/memory.json. Then scan Gmail (last 24h emails), Google Calendar (next 7 days), and conversation journals. Update the memory JSON with fresh life_context, any new people, updated priorities, and upcoming events. Return ONLY the full updated memory.json as valid JSON.`,
      { sendResult, role: 'lifesync', timeout: 300000 }
    );
    setTimeout(runLifeSync, msUntilNext7am());
  }

  setTimeout(runLifeSync, msUntilNext7am());
}

log.info('Nelson starting up', { pid: process.pid });
log.rotateIfNeeded();
startBot();
scheduleDailyHealthCheck();
scheduleDailyUpdater();
scheduleDailyLifeSync();
startWatchdog();
