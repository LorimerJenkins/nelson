require('dotenv').config();
const { Telegraf } = require('telegraf');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE_DIR = __dirname;
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_USER_ID = parseInt(process.env.TELEGRAM_ALLOWED_USER_ID);
const MEMORY_FILE = path.join(BASE_DIR, 'memory.json');
const HISTORY_FILE = path.join(BASE_DIR, 'conversation_history.json');
const PID_FILE = path.join(BASE_DIR, 'nelson.pid');
const ERROR_LOG = path.join(BASE_DIR, 'error_log.json');
const TOPICS_FILE = path.join(BASE_DIR, 'current_topics.json');
const SESSIONS_FILE = path.join(BASE_DIR, 'sessions.json');
const MAX_HISTORY = 50;
const CONVERSATIONS_DIR = path.join(
  process.env.HOME, '.claude/projects/-Users-nelson-nelson/memory/conversations'
);
const os = require('os');
const usage = require('./usage');
const tasks = require('./tasks');
const https = require('https');
const http = require('http');
const processedMessages = new Set();
const BOT_START_TIME = Math.floor(Date.now() / 1000);
const CLAUDE = process.env.CLAUDE_PATH || 'claude';
const ENV = { ...process.env, PATH: `${path.dirname(CLAUDE)}:/usr/local/bin:/usr/bin:/bin` };

// PID lock — prevent duplicate instances
function acquireLock() {
  try {
    if (fs.existsSync(PID_FILE)) {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
      try {
        process.kill(oldPid, 0); // Check if process is alive
        console.error(`Nelson already running (PID ${oldPid}). Exiting.`);
        process.exit(0);
      } catch {
        // Old process is dead — stale PID file, safe to overwrite
      }
    }
  } catch {}
  fs.writeFileSync(PID_FILE, String(process.pid));
}

function releaseLock() {
  try {
    const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
    if (parseInt(pid) === process.pid) fs.unlinkSync(PID_FILE);
  } catch {}
}

function logError(type, message, context = '', diagnose = false) {
  try {
    let errors = [];
    try { errors = JSON.parse(fs.readFileSync(ERROR_LOG, 'utf8')); } catch {}
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      message: String(message).slice(0, 1000),
      context: String(context).slice(0, 500),
      resolved: false,
      diagnosis: null
    };
    errors.push(entry);
    // Keep last 200 errors max
    if (errors.length > 200) errors = errors.slice(-200);
    fs.writeFileSync(ERROR_LOG, JSON.stringify(errors, null, 2));
    if (diagnose) setImmediate(() => diagnoseError(errors.length - 1, entry));
  } catch {}
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
      let errors = [];
      try { errors = JSON.parse(fs.readFileSync(ERROR_LOG, 'utf8')); } catch {}
      if (errors[index]) {
        errors[index].diagnosis = diagnosis;
        fs.writeFileSync(ERROR_LOG, JSON.stringify(errors, null, 2));
      }
      // Proactive alert — message Lorimer about the unhandled error
      if (botInstance && ALLOWED_USER_ID) {
        const time = entry.timestamp.split('T')[1].slice(0, 5);
        const alert = `⚠️ *Unhandled error at ${time}*\n\n\`${entry.type}\`: ${entry.message.slice(0, 300)}\n\n_Diagnosis:_\n${diagnosis.slice(0, 500)}`;
        botInstance.telegram.sendMessage(ALLOWED_USER_ID, alert, { parse_mode: 'Markdown' }).catch(() => {
          botInstance.telegram.sendMessage(ALLOWED_USER_ID, alert.replace(/[*_`]/g, '')).catch(() => {});
        });
      }
    } catch (err) {
      console.error('Error diagnosis failed:', err.message);
    }
  })();
}

acquireLock();

if (!TOKEN || !ALLOWED_USER_ID) {
  console.error('Missing required environment variables. Copy .env.example to .env and fill in your values.');
  process.exit(1);
}

function loadMemory() {
  try { return JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8')); }
  catch { return {}; }
}

function saveMemory(memory) {
  memory.last_updated = new Date().toISOString().split('T')[0];
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

function loadHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); }
  catch { return []; }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history));
}

function addToHistory(role, text) {
  const history = loadHistory();
  history.push({ role, text: text.slice(0, 2000), timestamp: new Date().toISOString() });
  while (history.length > MAX_HISTORY) history.shift();
  saveHistory(history);
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

function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); }
  catch { return { sessions: {}, active_session: null }; }
}

function saveSessions(data) {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
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

// Auto-generate a short topic name from a message (stateless Claude call)
async function autoNameSession(text) {
  try {
    const prompt = `Generate a short topic name (2-4 words, lowercase, hyphenated) for this message. Examples: "visa-petition", "chess-analysis", "nelson-bug-fix", "property-search". Return ONLY the topic name, nothing else.\n\nMessage: ${text.slice(0, 500)}`;
    const name = (await callClaudeAsync(prompt, { timeout: 30000, callType: 'session_name' })).trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').slice(0, 50);
    return name || 'chat-' + Date.now();
  } catch {
    return 'chat-' + Date.now();
  }
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

function loadRecentJournals(days = 3) {
  try {
    const files = fs.readdirSync(CONVERSATIONS_DIR)
      .filter(f => f.endsWith('.md'))
      .sort()
      .slice(-days);
    if (files.length === 0) return '';
    const entries = files.map(f =>
      fs.readFileSync(path.join(CONVERSATIONS_DIR, f), 'utf8').slice(0, 3000)
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

function updateMemoryInBackground(text, result, memory) {
  // Use async calls so we don't block the event loop
  (async () => {
    try {
      const prompt = `Update this memory JSON if anything important was said. Return ONLY valid JSON.\nCurrent: ${JSON.stringify(memory)}\nUser: ${text}\nAssistant: ${result}`;
      const update = await callClaudeAsync(prompt, { timeout: 60000, callType: 'memory_update' });
      const jsonMatch = update.match(/\{[\s\S]*\}/);
      if (jsonMatch) saveMemory(JSON.parse(jsonMatch[0]));
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
    console.error('Journal write failed:', err.message);
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

function startBot() {
  const bot = new Telegraf(TOKEN, { telegram: { timeout: 60000 } });
  botInstance = bot;

  bot.catch((err) => {
    const msg = err.message || '';
    // Ignore benign polling timeouts — Telegraf retries automatically
    if (msg.includes('timed out') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET') || msg.includes('network socket disconnected')) {
      console.log('Transient network error (ignored):', msg);
      return;
    }
    console.error('Bot error:', msg);
    logError('bot_framework', msg, err.stack ? err.stack.slice(0, 500) : '', true);
  });

  // --- Photo handler ---
  bot.on('photo', async (ctx) => {
    if (ctx.from.id !== ALLOWED_USER_ID) return;
    const msgId = ctx.message.message_id;
    if (ctx.message.date < BOT_START_TIME) return;
    if (processedMessages.has(msgId)) return;
    processedMessages.add(msgId);

    const caption = ctx.message.caption || '';
    // Build reply context if replying to a message
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
      // Get the highest resolution photo
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
        const topicsContext = topicsBlock();
        imagePrompt = `Here is your memory of the user:\n${JSON.stringify(memory, null, 2)}${journalBlock}${topicsContext}${historyBlock}${replyContext}\n\nLorimer sent a photo. The image is saved at: ${tmpPath}\nPlease read the image file at that path to see what it contains.\n${caption ? `Caption: ${caption}` : 'No caption provided.'}\n\nRespond naturally based on what you see in the image${caption ? ' and the caption' : ''}.`;
      } else {
        imagePrompt = `${replyContext}\n\nLorimer sent a photo. The image is saved at: ${tmpPath}\nPlease read the image file at that path to see what it contains.\n${caption ? `Caption: ${caption}` : 'No caption provided.'}\n\nRespond naturally based on what you see in the image${caption ? ' and the caption' : ''}.`;
      }

      const result = await callClaudeAsync(imagePrompt, { timeout: 300000, sessionName: activeSessionName });
      clearInterval(typingInterval);
      addToHistory('User', `[Photo]${caption ? ` ${caption}` : ''}`);
      addToHistory('Assistant', result);
      const chunks = chunkText(result);
      for (const chunk of chunks) await sendWithRetry(ctx, chunk);
      // Memory and topics updates removed — saves ~15k tokens per message
      // Memory updates happen on session close instead
      // Clean up temp file
      try { fs.unlinkSync(tmpPath); } catch {}
    } catch (err) {
      clearInterval(typingInterval);
      console.error('Photo handler error:', err.message);
      logError('photo_handler', err.message, '', true);
      try { await sendWithRetry(ctx, 'Had trouble processing that image. Try again?'); } catch {}
    }
  });

  // --- Reaction handler (no Claude call — saves ~2k tokens per reaction) ---
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
      // Simple acknowledgement — no Claude call needed
      const ack = newEmojis.includes('👍') || newEmojis.includes('❤') ? '👍' :
                  newEmojis.includes('😂') || newEmojis.includes('🤣') ? '😄' :
                  newEmojis.includes('🎉') ? '🎉' : '👍';
      await botInstance.telegram.sendMessage(update.chat.id, ack).catch(() => {});
    } catch (err) {
      console.error('Reaction handler error:', err.message);
    }
  });

  bot.on('text', async (ctx) => {
    if (ctx.from.id !== ALLOWED_USER_ID) return;
    const msgId = ctx.message.message_id;
    if (ctx.message.date < BOT_START_TIME) return; // Skip messages from before this boot
    if (processedMessages.has(msgId)) return;
    processedMessages.add(msgId);
    // Keep set from growing forever — prune old IDs
    if (processedMessages.size > 200) {
      const iter = processedMessages.values();
      for (let i = 0; i < 100; i++) processedMessages.delete(iter.next().value);
    }
    const text = ctx.message.text;

    // Top-level safety net — guarantees a reply no matter what goes wrong
    let repliedSuccessfully = false;
    try {

    if (text.toLowerCase().trim() === 'errors') {
      try {
        let errors = [];
        try { errors = JSON.parse(fs.readFileSync(ERROR_LOG, 'utf8')); } catch {}
        const today = new Date().toISOString().split('T')[0];
        const todayErrors = errors.filter(e => e.timestamp.startsWith(today));
        if (todayErrors.length === 0) {
          await sendWithRetry(ctx, 'No errors today.');
        } else {
          const summary = todayErrors.map((e, i) => {
            const time = e.timestamp.split('T')[1].slice(0, 5);
            let line = `*${i + 1}. ${time}* — \`${e.type}\`\n${e.message.slice(0, 200)}`;
            if (e.diagnosis) line += `\n_Diagnosis:_ ${e.diagnosis.slice(0, 300)}`;
            return line;
          }).join('\n\n');
          const chunks = chunkText(`*Errors today (${todayErrors.length}):*\n\n${summary}`);
          for (const chunk of chunks) await sendWithRetry(ctx, chunk);
        }
      } catch (err) {
        await sendWithRetry(ctx, 'Failed to read error log.').catch(() => {});
      }
      return;
    }

    if (text.toLowerCase().trim() === 'health') {
      try {
        const REPORTS_DIR = path.join(BASE_DIR, 'health_reports');
        const files = fs.readdirSync(REPORTS_DIR).filter(f => f.endsWith('.md')).sort();
        if (files.length === 0) {
          await sendWithRetry(ctx, 'No health reports yet. First one runs at 8am.');
        } else {
          const latest = fs.readFileSync(path.join(REPORTS_DIR, files[files.length - 1]), 'utf8');
          const chunks = chunkText(latest);
          for (const chunk of chunks) await sendWithRetry(ctx, chunk);
        }
      } catch (err) {
        await sendWithRetry(ctx, 'Failed to read health report.').catch(() => {});
      }
      return;
    }

    if (text.toLowerCase().trim() === 'restart') {
      await sendWithRetry(ctx, 'Restarting now...').catch(() => {});
      console.log('Restart requested via Telegram');
      releaseLock();
      const child = spawn(process.execPath, [__filename], {
        detached: true,
        stdio: 'ignore',
        cwd: BASE_DIR,
        env: ENV
      });
      child.unref();
      process.exit(0);
    }

    if (['sessions', 'topics'].includes(text.toLowerCase().trim())) {
      const sessions = listSessions();
      if (sessions.length === 0) {
        await sendWithRetry(ctx, 'No sessions yet.');
      } else {
        const lines = sessions.map(s => {
          const active = s.active ? ' ← *active*' : '';
          const msgs = s.message_count || 0;
          const lastUsed = s.last_used ? new Date(s.last_used).toLocaleString('en-GB', { timeZone: 'Europe/London' }) : 'never';
          return `• *${s.name}* — ${msgs} messages, last used: ${lastUsed}${active}`;
        }).join('\n');
        await sendWithRetry(ctx, `*Sessions:*\n\n${lines}\n\nSay "back to [topic]" to switch, "new topic: [name]" to create, or "end session" to close the current one.`);
      }
      return;
    }

    if (text.toLowerCase().trim() === 'usage') {
      const report = usage.formatUsageReport();
      await sendWithRetry(ctx, report);
      return;
    }

    if (text.toLowerCase().trim() === 'tasks') {
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
      await sendWithRetry(ctx, msg);
      return;
    }

    // Cancel a background task
    if (text.toLowerCase().trim().startsWith('cancel task')) {
      const taskId = text.trim().split(/\s+/).pop();
      if (tasks.cancelTask(taskId)) {
        await sendWithRetry(ctx, `Task \`${taskId}\` cancelled.`);
      } else {
        await sendWithRetry(ctx, `No active task with ID \`${taskId}\`.`);
      }
      return;
    }

    // Detect background task requests
    const bgPatterns = [
      /^(?:go|please go|nelson go)\s+(.+)/i,
      /^(?:background|bg|task)[:\s]+(.+)/i,
      /^(?:in the background)[,:\s]+(.+)/i,
      /^(?:autonomously|independently)[,:\s]+(.+)/i,
    ];
    let bgMatch = null;
    for (const pattern of bgPatterns) {
      const m = text.match(pattern);
      if (m) { bgMatch = m[1].trim(); break; }
    }
    if (bgMatch) {
      const memory = loadMemory();
      const context = `User memory summary: ${JSON.stringify(memory.core || {})}\nBrowser available: node browse.js goto/screenshot/click/type/text/close`;
      const sendResult = (message) => {
        const chunks = chunkText(message);
        for (const chunk of chunks) {
          botInstance.telegram.sendMessage(ALLOWED_USER_ID, chunk, { parse_mode: 'Markdown' }).catch(() => {
            botInstance.telegram.sendMessage(ALLOWED_USER_ID, chunk.replace(/[*_`]/g, '')).catch(() => {});
          });
        }
      };
      const { taskId, description } = tasks.launchTask(bgMatch, context, { sendResult });
      await sendWithRetry(ctx, `🚀 Task launched: _${description}_\n\nID: \`${taskId}\`\nI'll message you when it's done. You can keep chatting normally.\n\nSend "tasks" to check status.`);
      return;
    }

    if (text.toLowerCase().trim() === 'end session' || text.toLowerCase().trim() === 'close session') {
      const data = loadSessions();
      const current = data.active_session;
      if (current) {
        data.active_session = null;
        saveSessions(data);
        await sendWithRetry(ctx, `Session "${current}" closed. Next message will start a new topic.`);
        // Update memory on session close (instead of per-message)
        const history = loadHistory();
        const recentExchanges = history.slice(-10).map(m => `${m.role}: ${m.text}`).join('\n');
        if (recentExchanges.length > 50) {
          setImmediate(() => updateMemoryInBackground(recentExchanges, '', loadMemory()));
        }
      } else {
        await sendWithRetry(ctx, 'No active session. Next message will start a new topic.');
      }
      return;
    }

    const rebootKeywords = ['reboot', 'reboot the mac', 'full restart', 'restart the mac', 'restart mac mini', 'reboot mac mini', 'hard reset', 'do a reboot', 'do a full restart'];
    if (rebootKeywords.some(k => text.toLowerCase().trim().includes(k))) {
      const REBOOT_SECONDS = 90;
      const returnTime = new Date(Date.now() + REBOOT_SECONDS * 1000);
      const timeStr = returnTime.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'Europe/London' });
      await sendWithRetry(ctx, `Rebooting the Mac Mini now. I should be back by ${timeStr} (~${REBOOT_SECONDS}s). See you on the other side.`).catch(() => {});
      console.log('Full reboot requested via Telegram');
      releaseLock();
      spawn('sudo', ['/sbin/reboot'], { detached: true, stdio: 'ignore' });
      process.exit(0);
    }

    touchActivity();
    const memory = loadMemory();

    const typingInterval = setInterval(() => {
      ctx.telegram.sendChatAction(ctx.chat.id, 'typing').catch(() => {});
    }, 5000);

    // Progress message — let Lorimer know if it's taking a while
    let progressSent = false;
    const progressTimer = setTimeout(async () => {
      progressSent = true;
      await sendWithRetry(ctx, 'Still thinking on this one...').catch(() => {});
    }, 30000);

    try {
      const history = loadHistory();
      const historyBlock = history.length > 0
        ? `\n\nRecent conversation:\n${history.map(m => `${m.role}: ${m.text}`).join('\n')}`
        : '';
      const journalBlock = loadRecentJournals();
      // Reply context — if Lorimer is replying to a specific message, include it
      let replyContext = '';
      if (ctx.message.reply_to_message) {
        const orig = ctx.message.reply_to_message;
        const origText = orig.text || orig.caption || '[non-text message]';
        replyContext = `\n\n[Lorimer is replying to this earlier message: "${origText.slice(0, 1000)}"]`;
      }
      const topicsContext = topicsBlock();

      // Detect topic switching
      const topicSwitch = detectTopicSwitch(text);
      let activeSessionName;
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
        // No active session — auto-create a new topic session from the message
        if (!activeSessionName) {
          activeSessionName = await autoNameSession(text);
          setActiveSession(activeSessionName);
          topicSwitchNotice = `\n\n[New topic session created: "${activeSessionName}"]`;
        }
      }

      // First message in a session gets full context bootstrap; subsequent messages are lightweight
      let prompt;
      if (isFirstSessionMessage(activeSessionName)) {
        prompt = `Here is your memory of the user:\n${JSON.stringify(memory, null, 2)}${journalBlock}${topicsContext}${historyBlock}${replyContext}${topicSwitchNotice}\n\nUser says: ${text}`;
      } else {
        // Session already has context — just send the message with minimal framing
        prompt = `${replyContext}${topicSwitchNotice}\n\nUser says: ${text}`;
      }

      let result;
      try {
        result = await callClaudeAsync(prompt, { timeout: 300000, sessionName: activeSessionName });
      } catch (retryErr) {
        // Session rotation — if the session failed, archive it, create fresh, and retry once
        if (retryErr.sessionFailed) {
          console.log(`Session "${activeSessionName}" failed — rotating to new session`);
          archiveSession(activeSessionName);
          // Retry with full context since it's a fresh session
          const freshPrompt = `Here is your memory of the user:\n${JSON.stringify(memory, null, 2)}${journalBlock}${topicsContext}${historyBlock}${replyContext}${topicSwitchNotice}\n\nUser says: ${text}`;
          result = await callClaudeAsync(freshPrompt, { timeout: 300000, sessionName: activeSessionName });
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
      // Proactive usage warning
      const warning = usage.getWarningMessage();
      if (warning) await sendWithRetry(ctx, warning).catch(() => {});
      repliedSuccessfully = true;
      touchActivity();
      // Memory and topics updates removed — saves ~15k tokens per message
      // Memory updates happen on session close instead
    } catch (err) {
      clearTimeout(progressTimer);
      touchActivity();
      clearInterval(typingInterval);
      const msg = (err.message || '') + (err.stderr || '') + (err.stdout || '');
      let reply;
      if (err.message === 'NELSON_TIMEOUT') {
        reply = 'That was too complex — I hit my 5-minute limit. Try breaking it into a simpler question.';
        logError('timeout', 'Claude response exceeded 300s', `User message: ${text.slice(0, 200)}`);
      } else if (err.killed || msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
        reply = 'That took too long and timed out. Try again or simplify the question.';
        logError('timeout', msg, `User message: ${text.slice(0, 200)}`);
      } else if (msg.includes('Command failed') || msg.includes('usage') || msg.includes('limit') || msg.includes('rate') || msg.includes('capacity')) {
        reply = 'Claude usage limit reached — I\'ll be back once it resets.';
        usage.logLimitHit();
        logError('usage_limit', 'Claude usage limit reached', `User message: ${text.slice(0, 200)}`);
      } else {
        reply = 'Something went wrong — try again in a moment.';
        logError('unhandled_response', msg, `User message: ${text.slice(0, 200)}`, true);
      }
      // Guarantee a reply gets through — try Markdown, then plain text, then raw API
      try {
        await sendWithRetry(ctx, reply);
        repliedSuccessfully = true;
      } catch {
        try {
          await ctx.reply(reply);
          repliedSuccessfully = true;
        } catch (finalErr) {
          console.error('CRITICAL: Failed to send ANY reply:', finalErr.message);
          logError('reply_failure', finalErr.message, `Reply was: ${reply}`);
        }
      }
    }

    } catch (outerErr) {
      // Top-level safety net — no matter what goes wrong, always try to reply
      console.error('Top-level handler error:', outerErr.message);
      logError('handler_crash', outerErr.message, outerErr.stack ? outerErr.stack.slice(0, 500) : '', true);
      if (!repliedSuccessfully) {
        try { await ctx.reply('Something went wrong internally. Try again or send "restart" if I seem stuck.'); } catch {}
      }
    }
  });

  // Log all raw updates for debugging
  bot.use((ctx, next) => {
    const updateType = Object.keys(ctx.update).filter(k => k !== 'update_id').join(', ');
    console.log(`Update received — type: ${updateType}`);
    return next();
  });

  bot.launch({
    allowedUpdates: ['message', 'message_reaction', 'message_reaction_count', 'callback_query']
  }).then(() => {
    console.log('Nelson is live.');
    bot.telegram.sendMessage(ALLOWED_USER_ID, 'Nelson is online.').catch(() => {});
  }).catch(err => {
    console.error('Bot crashed:', err.message);
    setTimeout(startBot, 30000);
  });

  process.once('SIGINT', () => { releaseLock(); bot.stop('SIGINT'); });
  process.once('SIGTERM', () => { releaseLock(); bot.stop('SIGTERM'); });
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
  logError('uncaughtException', err.message, err.stack ? err.stack.slice(0, 500) : '', true);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
  logError('unhandledRejection', String(err), err && err.stack ? err.stack.slice(0, 500) : '', true);
});

// Log rotation — keep nelson.log under 5MB, retain 2 old copies
function rotateLogIfNeeded() {
  const logFile = path.join(BASE_DIR, 'nelson.log');
  try {
    if (!fs.existsSync(logFile)) return;
    const stats = fs.statSync(logFile);
    if (stats.size < 5 * 1024 * 1024) return; // Under 5MB, no action
    // Rotate: .2 → delete, .1 → .2, current → .1
    const log2 = logFile + '.2';
    const log1 = logFile + '.1';
    try { fs.unlinkSync(log2); } catch {}
    try { fs.renameSync(log1, log2); } catch {}
    fs.renameSync(logFile, log1);
    fs.writeFileSync(logFile, ''); // Fresh log
    console.log('Log rotated — nelson.log exceeded 5MB');
  } catch (err) {
    console.error('Log rotation failed:', err.message);
  }
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
    console.log(`[${today}] Running daily health check...`);

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
      const pkg = JSON.parse(fileContents['package.json'] || '{}');
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
      console.log(`Health report saved to ${reportFile}`);
    } catch (err) {
      console.error('Health check diagnosis failed:', err.message);
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
    const idleMinutes = (Date.now() - lastActivityTime) / 60000;
    // If idle for more than 10 minutes and the process has been running for at least 15 min, that's fine — no messages
    // But we write the timestamp so the cron health check can verify we're alive
    const watchdogFile = path.join(BASE_DIR, 'watchdog.txt');
    fs.writeFileSync(watchdogFile, `${Date.now()}\n${process.pid}`);
  }, 60000); // Write heartbeat every minute
}

console.log('Nelson is running...');
startBot();
scheduleDailyHealthCheck();
startWatchdog();
