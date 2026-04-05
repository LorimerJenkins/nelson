const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');

const PROJECT_ROOT = path.join(__dirname, '..');
const TASKS_FILE = path.join(PROJECT_ROOT, 'data', 'tasks.json');
const BASE_DIR = PROJECT_ROOT;
const CLAUDE = process.env.CLAUDE_PATH || 'claude';
const ENV = { ...process.env, PATH: `${path.dirname(CLAUDE)}:/usr/local/bin:/usr/bin:/bin` };

function loadTasks() {
  try { return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf8')); }
  catch { return { active: [], completed: [] }; }
}

function saveTasks(data) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2));
}

// Launch a background task — returns immediately, sends result to Telegram when done
// role: 'general' or 'dev' — determines working directory and CLAUDE.md
function launchTask(description, context, { sendResult, timeout = 600000, role = 'general' } = {}) {
  const taskId = randomUUID().slice(0, 8);
  const sessionId = randomUUID();
  const roleDir = path.join(PROJECT_ROOT, 'roles', role);

  const data = loadTasks();
  const task = {
    id: taskId,
    description,
    status: 'running',
    role,
    session_id: sessionId,
    started_at: new Date().toISOString(),
    pid: null
  };
  data.active.push(task);
  saveTasks(data);

  // Build the prompt with context
  const roleName = role === 'dev' ? 'Nelson Dev' : 'Nelson';
  const prompt = `You are ${roleName}, running an autonomous background task. Complete this task fully and return the result.

Task: ${description}

${context ? `Context:\n${context}\n` : ''}

Important:
- Complete the task independently — don't ask questions, just do your best
- Be thorough but concise in your output
- If you need to browse the web, use: node ${PROJECT_ROOT}/lib/browse.js goto "url" or screenshot "name"
- If you need to create files, create them in the working directory or ~/projects/
- Return a clear summary of what you did and the results`;

  const args = ['--print', '--session-id', sessionId, '--dangerously-skip-permissions'];

  // Dev role runs from the role directory (which has its own CLAUDE.md)
  const taskCwd = role === 'dev' ? roleDir : BASE_DIR;
  const proc = spawn(CLAUDE, args, {
    cwd: taskCwd,
    env: ENV,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true
  });

  // Update PID
  const taskData = loadTasks();
  const activeTask = taskData.active.find(t => t.id === taskId);
  if (activeTask) {
    activeTask.pid = proc.pid;
    saveTasks(taskData);
  }

  let stdout = '';
  let stderr = '';
  let killed = false;

  proc.stdout.on('data', (d) => { stdout += d.toString(); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); });

  // Timeout
  const timer = setTimeout(() => {
    killed = true;
    proc.kill('SIGKILL');
  }, timeout);

  proc.on('close', (code) => {
    clearTimeout(timer);

    const taskData = loadTasks();
    const idx = taskData.active.findIndex(t => t.id === taskId);
    if (idx !== -1) {
      const finished = taskData.active.splice(idx, 1)[0];
      finished.status = killed ? 'timeout' : (code === 0 || stdout.trim() ? 'completed' : 'failed');
      finished.completed_at = new Date().toISOString();
      finished.result = stdout.slice(0, 5000) || stderr.slice(0, 1000) || 'No output';
      taskData.completed.push(finished);
      // Keep last 50 completed tasks
      if (taskData.completed.length > 50) taskData.completed = taskData.completed.slice(-50);
      saveTasks(taskData);
    }

    // Send result back to Telegram
    if (sendResult) {
      let message;
      if (killed) {
        message = `⏱ *Background task timed out*\n\n_${description}_\n\nThe task exceeded the 10-minute limit.`;
      } else if (code !== 0 && !stdout.trim()) {
        message = `❌ *Background task failed*\n\n_${description}_\n\n${stderr.slice(0, 500)}`;
      } else {
        const result = stdout.trim().slice(0, 3500);
        message = `✅ *Background task complete*\n\n_${description}_\n\n${result}`;
      }
      sendResult(message);
    }
  });

  proc.stdin.write(prompt);
  proc.stdin.end();
  proc.unref();

  return { taskId, description };
}

// Cancel a running task
function cancelTask(taskId) {
  const data = loadTasks();
  const task = data.active.find(t => t.id === taskId);
  if (!task) return false;

  if (task.pid) {
    try { process.kill(task.pid, 'SIGKILL'); } catch {}
  }

  const idx = data.active.findIndex(t => t.id === taskId);
  if (idx !== -1) {
    const cancelled = data.active.splice(idx, 1)[0];
    cancelled.status = 'cancelled';
    cancelled.completed_at = new Date().toISOString();
    data.completed.push(cancelled);
    saveTasks(data);
  }
  return true;
}

// List tasks
function listActiveTasks() {
  const data = loadTasks();
  return data.active;
}

function listRecentTasks(limit = 5) {
  const data = loadTasks();
  return data.completed.slice(-limit);
}

module.exports = {
  launchTask,
  cancelTask,
  listActiveTasks,
  listRecentTasks,
  loadTasks
};
