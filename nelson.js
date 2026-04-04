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
const MAX_HISTORY = 50;
const CONVERSATIONS_DIR = path.join(
  process.env.HOME, '.claude/projects/-Users-nelson-nelson/memory/conversations'
);
const os = require('os');
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

      const diagnosis = (await callClaudeAsync(prompt, { timeout: 60000 })).trim();
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
function callClaudeAsync(input, { timeout = 120000, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(CLAUDE, ['--print', '--dangerously-skip-permissions'], {
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
        reject(new Error(stderr || stdout || `Process exited with code ${code}`));
      } else {
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

function updateMemoryInBackground(text, result, memory) {
  // Use async calls so we don't block the event loop
  (async () => {
    try {
      const prompt = `Update this memory JSON if anything important was said. Return ONLY valid JSON.\nCurrent: ${JSON.stringify(memory)}\nUser: ${text}\nAssistant: ${result}`;
      const update = await callClaudeAsync(prompt, { timeout: 60000 });
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

    const summary = (await callClaudeAsync(prompt, { timeout: 60000 })).trim();

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
      const history = loadHistory();
      const historyBlock = history.length > 0
        ? `\n\nRecent conversation:\n${history.map(m => `${m.role}: ${m.text}`).join('\n')}`
        : '';
      const journalBlock = loadRecentJournals();

      const imagePrompt = `Here is your memory of the user:\n${JSON.stringify(memory, null, 2)}${journalBlock}${historyBlock}${replyContext}\n\nLorimer sent a photo. The image is saved at: ${tmpPath}\nPlease read the image file at that path to see what it contains.\n${caption ? `Caption: ${caption}` : 'No caption provided.'}\n\nRespond naturally based on what you see in the image${caption ? ' and the caption' : ''}.`;

      const result = await callClaudeAsync(imagePrompt, { timeout: 120000 });
      clearInterval(typingInterval);
      addToHistory('User', `[Photo]${caption ? ` ${caption}` : ''}`);
      addToHistory('Assistant', result);
      const chunks = chunkText(result);
      for (const chunk of chunks) await sendWithRetry(ctx, chunk);
      setImmediate(() => updateMemoryInBackground(caption || '[Photo sent]', result, memory));
      // Clean up temp file
      try { fs.unlinkSync(tmpPath); } catch {}
    } catch (err) {
      clearInterval(typingInterval);
      console.error('Photo handler error:', err.message);
      logError('photo_handler', err.message, '', true);
      try { await sendWithRetry(ctx, 'Had trouble processing that image. Try again?'); } catch {}
    }
  });

  // --- Reaction handler ---
  bot.on('message_reaction', async (ctx) => {
    try {
      console.log('RAW reaction update:', JSON.stringify(ctx.update, null, 2));
      const update = ctx.update.message_reaction;
      if (!update) {
        console.log('No message_reaction field in update');
        return;
      }

      // Check user identity — user field may or may not be present
      const userId = update.user?.id || ctx.from?.id || update.actor_chat?.id;
      if (userId !== ALLOWED_USER_ID) return;

      const newEmojis = (update.new_reaction || [])
        .map(r => r.emoji || r.custom_emoji_id || '?')
        .join(' ');
      if (!newEmojis) return; // Reaction removed, ignore

      const msgId = update.message_id;
      const storedMessages = loadHistory();

      const memory = loadMemory();
      const reactionPrompt = `Here is your memory of the user:\n${JSON.stringify(memory, null, 2)}\n\nRecent conversation:\n${storedMessages.map(m => `${m.role}: ${m.text}`).join('\n')}\n\nLorimer reacted with ${newEmojis} to a message in our chat. The message ID is ${msgId}. Based on our recent conversation, acknowledge the reaction naturally. Keep it very brief — one short sentence max. If it's a thumbs up or similar positive reaction, a simple acknowledgement is fine. Don't overthink it.`;

      const result = await callClaudeAsync(reactionPrompt, { timeout: 30000 });
      const trimmed = result.trim();
      if (trimmed && trimmed.length > 0 && trimmed.length < 500) {
        await botInstance.telegram.sendMessage(update.chat.id, trimmed, { parse_mode: 'Markdown' }).catch(() => {
          botInstance.telegram.sendMessage(update.chat.id, trimmed).catch(() => {});
        });
      }
    } catch (err) {
      console.error('Reaction handler error:', err.message);
      // Don't log or alert for reaction failures — not critical
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
      const memoryContext = `Here is your memory of the user:\n${JSON.stringify(memory, null, 2)}${journalBlock}${historyBlock}${replyContext}\n\nUser says: ${text}`;
      const result = await callClaudeAsync(memoryContext, { timeout: 120000 });
      clearTimeout(progressTimer);
      clearInterval(typingInterval);
      addToHistory('User', text);
      addToHistory('Assistant', result);
      const chunks = chunkText(result);
      for (const chunk of chunks) await sendWithRetry(ctx, chunk);
      repliedSuccessfully = true;
      touchActivity();
      setImmediate(() => updateMemoryInBackground(text, result, memory));
    } catch (err) {
      clearTimeout(progressTimer);
      touchActivity();
      clearInterval(typingInterval);
      const msg = (err.message || '') + (err.stderr || '') + (err.stdout || '');
      let reply;
      if (err.message === 'NELSON_TIMEOUT') {
        reply = 'That was too complex — I hit my 2-minute limit. Try breaking it into a simpler question.';
        logError('timeout', 'Claude response exceeded 120s', `User message: ${text.slice(0, 200)}`);
      } else if (err.killed || msg.includes('ETIMEDOUT') || msg.includes('timed out')) {
        reply = 'That took too long and timed out. Try again or simplify the question.';
        logError('timeout', msg, `User message: ${text.slice(0, 200)}`);
      } else if (msg.includes('Command failed') || msg.includes('usage') || msg.includes('limit') || msg.includes('rate') || msg.includes('capacity')) {
        reply = 'Claude usage limit reached — I\'ll be back once it resets.';
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

    // Gather all project files and their contents for thorough audit
    const files = fs.readdirSync(BASE_DIR).filter(f => !f.startsWith('.') && !f.startsWith('node_modules'));
    const fileContents = {};
    for (const f of files) {
      const fp = path.join(BASE_DIR, f);
      try {
        const stat = fs.statSync(fp);
        if (stat.isFile() && stat.size < 50000) {
          fileContents[f] = fs.readFileSync(fp, 'utf8');
        }
      } catch {}
    }

    // Check for referenced files/paths that don't exist
    let nelsonJs = fileContents['nelson.js'] || '';
    const referencedPaths = [];
    const pathMatches = nelsonJs.match(/path\.join\([^)]+\)/g) || [];
    for (const pm of pathMatches) {
      referencedPaths.push(pm);
    }

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

    // Phase 1: Diagnose and report
    const diagnosePrompt = `You are Nelson's daily health check system. Today is ${today}. Do a thorough analysis and produce a health report.

## Unresolved Errors (${unresolvedErrors.length})
${unresolvedErrors.length > 0 ? JSON.stringify(unresolvedErrors.slice(-30), null, 2) : 'None'}

## Project Files
${files.join(', ')}

## File Contents
${Object.entries(fileContents).map(([name, content]) => `### ${name}\n\`\`\`\n${content.slice(0, 8000)}\n\`\`\``).join('\n\n')}

## Dependency Check
${depCheck}

## Crontab
${crontab}

## Running Processes
${processInfo}

## Path References in nelson.js
${referencedPaths.join('\n')}

---

Produce a thorough report:

1. **Error Analysis** — for each unresolved error: root cause, severity, and a specific fix (exact code change needed). If none, say so.
2. **Code Audit** — check ALL files for: broken file references, incorrect path names, logic bugs, potential crashes, race conditions, security issues, missing error handling that could cause silent failures.
3. **Cross-File Consistency** — do file references match actual file names? Do environment variable names match between .env.example and code? Do package.json scripts reference correct files?
4. **System Health** — process running correctly, crontab entries valid, dependencies installed, file permissions OK.
5. **Self-Improvement** — anything about how Nelson works that could be better: response quality, memory handling, conversation flow, error recovery.
6. **Fix Plan** — for every issue found, provide a specific fix in order of priority. Mark each as AUTO_FIX (safe to apply automatically) or MANUAL_FIX (needs Lorimer's approval).

Be specific and actionable. Reference exact line numbers and file names.`;

    let report = '';
    let fixesApplied = [];

    try {
      report = await callClaudeAsync(diagnosePrompt, { timeout: 300000 });
      const reportFile = path.join(REPORTS_DIR, `${today}.md`);
      fs.writeFileSync(reportFile, `# Daily Health Report — ${today}\n\n${report}`);
      console.log(`Health report saved to ${reportFile}`);
    } catch (err) {
      console.error('Health check diagnosis failed:', err.message);
      logError('health_check', err.message, 'Health check diagnosis phase failed');
      setTimeout(runHealthCheck, msUntilNext8am());
      return;
    }

    // Phase 2: Auto-fix safe issues
    if (report.includes('AUTO_FIX')) {
      try {
        const fixPrompt = `You are Nelson's auto-repair system. Based on this health report, apply all AUTO_FIX items.

## Health Report
${report}

## Current nelson.js
${nelsonJs}

For each AUTO_FIX item:
1. Make the change
2. Verify the change is safe (won't break the bot)
3. List what you changed

IMPORTANT: Only fix issues marked AUTO_FIX. Do NOT touch anything marked MANUAL_FIX. Be conservative — if you're not 100% sure a fix is safe, skip it.

After applying fixes, output a summary in this format:
FIXES_APPLIED:
- <description of fix 1>
- <description of fix 2>
(or "FIXES_APPLIED: none" if nothing was safe to fix)`;

        const fixResult = await callClaudeAsync(fixPrompt, { timeout: 300000 });
        const fixMatch = fixResult.match(/FIXES_APPLIED:\n([\s\S]*?)(?:\n\n|$)/);
        if (fixMatch && !fixMatch[1].includes('none')) {
          fixesApplied = fixMatch[1].split('\n').filter(l => l.trim().startsWith('-')).map(l => l.trim());
        }
      } catch (err) {
        console.error('Auto-fix phase failed:', err.message);
        logError('health_check_fix', err.message, 'Auto-fix phase failed');
      }
    }

    // Mark errors as reviewed
    errors.forEach(e => {
      if (!e.reviewed) e.reviewed = today;
    });
    fs.writeFileSync(ERROR_LOG, JSON.stringify(errors, null, 2));

    // Send detailed summary to Lorimer
    if (botInstance && ALLOWED_USER_ID) {
      let summary = `*Daily Health Check — ${today}*\n\n`;

      if (unresolvedErrors.length === 0) {
        summary += `No unresolved errors.\n\n`;
      } else {
        summary += `${unresolvedErrors.length} unresolved error(s) found and analysed.\n\n`;
      }

      if (fixesApplied.length > 0) {
        summary += `*Auto-fixes applied:*\n${fixesApplied.join('\n')}\n\n`;
      }

      summary += `Say "health" to see the full report.`;

      botInstance.telegram.sendMessage(ALLOWED_USER_ID, summary, { parse_mode: 'Markdown' }).catch(() => {
        botInstance.telegram.sendMessage(ALLOWED_USER_ID, summary.replace(/[*_`]/g, '')).catch(() => {});
      });

      // If fixes were applied, restart Nelson to pick them up
      if (fixesApplied.length > 0) {
        console.log('Auto-fixes applied, restarting Nelson...');
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
