const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const store = require('./store');
const log = require('./logger').child({ component: 'tasks' });

const PROJECT_ROOT = path.join(__dirname, '..');
const TASKS_FILE = path.join(PROJECT_ROOT, 'data', 'tasks.json');
const BASE_DIR = PROJECT_ROOT;
const CLAUDE = process.env.CLAUDE_PATH || 'claude';
const ENV = { ...process.env, PATH: `${path.dirname(CLAUDE)}:/usr/local/bin:/usr/bin:/bin` };
const TASKS_DEFAULT = { active: [], completed: [] };

function loadTasks() {
  return store.load(TASKS_FILE, TASKS_DEFAULT);
}

function saveTasks(data) {
  store.saveSync(TASKS_FILE, data);
}

const MAX_CONCURRENT = 3;

// Launch a background task — returns immediately, sends result to Telegram when done
// role: 'general' or 'dev' — determines working directory and CLAUDE.md
function launchTask(description, context, { sendResult, timeout = 600000, role = 'general' } = {}) {
  const data = loadTasks();

  // Enforce concurrent limit
  if (data.active.length >= MAX_CONCURRENT) {
    if (sendResult) {
      sendResult(`⚠️ Can't start task — ${MAX_CONCURRENT} tasks already running. Send "tasks" to see them, or "cancel task [id]" to free a slot.`);
    }
    return { taskId: null, description, blocked: true };
  }

  const taskId = randomUUID().slice(0, 8);
  const sessionId = randomUUID();
  const roleDir = path.join(PROJECT_ROOT, 'roles', role);

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
  log.info('task launched', { taskId, role, description: description.slice(0, 100) });

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

    log.info('task finished', { taskId, status: killed ? 'timeout' : (code === 0 || stdout.trim() ? 'completed' : 'failed') });

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

// Sprint-based dev runner — runs multiple sprints sequentially, committing after each
function launchSprintTask(description, projectDir, { sendResult, sprintMinutes = 30, totalHours = 8 } = {}) {
  const data = loadTasks();
  if (data.active.length >= MAX_CONCURRENT) {
    if (sendResult) sendResult(`⚠️ Can't start — ${MAX_CONCURRENT} tasks already running.`);
    return { taskId: null, description, blocked: true };
  }

  const taskId = randomUUID().slice(0, 8);
  const totalSprints = Math.ceil((totalHours * 60) / sprintMinutes);
  const sprintTimeout = sprintMinutes * 60 * 1000;
  const roleDir = path.join(PROJECT_ROOT, 'roles', 'dev');

  const task = {
    id: taskId,
    description,
    status: 'running',
    role: 'dev',
    type: 'sprint',
    project_dir: projectDir,
    total_sprints: totalSprints,
    current_sprint: 0,
    started_at: new Date().toISOString(),
    pid: null
  };
  data.active.push(task);
  saveTasks(data);

  if (sendResult) {
    sendResult(`🏃 *Sprint build started*\n\n_${description}_\n\nID: \`${taskId}\`\nSprints: up to ${totalSprints} x ${sprintMinutes}min\nProject: ${projectDir}\n\nI'll update you after each sprint. Send "cancel task ${taskId}" to stop.`);
  }

  // Run sprints sequentially
  async function runSprint(sprintNum) {
    // Check if task was cancelled
    const currentData = loadTasks();
    const activeTask = currentData.active.find(t => t.id === taskId);
    if (!activeTask) return; // Cancelled

    // Update sprint number
    activeTask.current_sprint = sprintNum;
    saveTasks(currentData);

    const isFirst = sprintNum === 1;
    const isLast = sprintNum >= totalSprints;

    const prompt = isFirst
      ? `You are Nelson Dev starting a new project build.

PROJECT: ${description}
DIRECTORY: ${projectDir}

This is SPRINT 1 of up to ${totalSprints}. You have ${sprintMinutes} minutes.

Steps for this sprint:
1. Create the project directory: mkdir -p ${projectDir}
2. Initialise the project (npm init, git init, install dependencies)
3. Scaffold the basic structure
4. Get something running — even if minimal
5. Git commit your progress

At the end, output a STATUS REPORT:
SPRINT: 1/${totalSprints}
DONE: [what you completed]
NEXT: [what the next sprint should focus on]
FILES: [key files created]`
      : `You are Nelson Dev continuing a project build.

PROJECT: ${description}
DIRECTORY: ${projectDir}

This is SPRINT ${sprintNum} of up to ${totalSprints}. You have ${sprintMinutes} minutes.
${isLast ? '\nThis is the FINAL sprint — focus on polishing, testing, and deploying.' : ''}

Steps:
1. Read the codebase in ${projectDir} to understand current state
2. Continue building — focus on the most impactful work
3. Git commit your progress
${isLast ? '4. Deploy if possible (Netlify, Vercel, or document how to deploy)' : ''}

At the end, output a STATUS REPORT:
SPRINT: ${sprintNum}/${totalSprints}
DONE: [what you completed this sprint]
NEXT: [what the next sprint should focus on]
FILES: [key files modified]`;

    return new Promise((resolve) => {
      const sessionId = randomUUID();
      const args = ['--print', '--session-id', sessionId, '--dangerously-skip-permissions'];
      const proc = spawn(CLAUDE, args, {
        cwd: roleDir,
        env: ENV,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true
      });

      // Update PID
      const td = loadTasks();
      const at = td.active.find(t => t.id === taskId);
      if (at) { at.pid = proc.pid; saveTasks(td); }

      let stdout = '';
      let stderr = '';
      let killed = false;

      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      const timer = setTimeout(() => { killed = true; proc.kill('SIGKILL'); }, sprintTimeout);

      proc.on('close', (code) => {
        clearTimeout(timer);
        const result = stdout.trim().slice(0, 3000) || stderr.slice(0, 500) || 'No output';
        const hitTokenLimit = (stderr + stdout).match(/usage|limit|rate|capacity/i);

        // Send sprint update
        if (sendResult) {
          const icon = hitTokenLimit ? '⏸️' : killed ? '⏱' : (code === 0 || stdout.trim() ? '✅' : '❌');
          sendResult(`${icon} *Sprint ${sprintNum}/${totalSprints} complete*\n\n${result.slice(0, 2000)}`);
        }

        resolve({ success: !killed && (code === 0 || stdout.trim()), result, hitTokenLimit: !!hitTokenLimit });
      });

      proc.stdin.write(prompt);
      proc.stdin.end();
      proc.unref();
    });
  }

  // Run all sprints sequentially — waits for token reset if limit hit
  (async () => {
    for (let i = 1; i <= totalSprints; i++) {
      // Check if cancelled
      const check = loadTasks();
      if (!check.active.find(t => t.id === taskId)) break;

      const { success, hitTokenLimit } = await runSprint(i);

      // Token limit hit — wait and retry
      if (hitTokenLimit) {
        if (sendResult) sendResult(`⏸️ *Token limit hit after sprint ${i}/${totalSprints}*\n\nProgress saved. Waiting 30 minutes for allowance to reset, then continuing automatically.`);
        await new Promise(r => setTimeout(r, 30 * 60 * 1000)); // Wait 30 mins
        // Retry the same sprint
        const retry = await runSprint(i);
        if (retry.hitTokenLimit) {
          // Still limited — wait another 30 mins
          if (sendResult) sendResult(`⏸️ Still limited. Waiting another 30 minutes...`);
          await new Promise(r => setTimeout(r, 30 * 60 * 1000));
          // Try once more then move on
          await runSprint(i);
        }
        continue;
      }

      // If sprint failed for non-token reasons, retry once then stop
      if (!success && i < totalSprints) {
        if (sendResult) sendResult(`⚠️ Sprint ${i} had issues — retrying...`);
        const retry = await runSprint(i);
        if (!retry || !retry.success) {
          if (sendResult) sendResult(`❌ Sprint ${i} failed twice — stopping build. Progress is committed in ${projectDir}.`);
          break;
        }
      }
    }

    // Mark task complete
    const finalData = loadTasks();
    const idx = finalData.active.findIndex(t => t.id === taskId);
    if (idx !== -1) {
      const finished = finalData.active.splice(idx, 1)[0];
      finished.status = 'completed';
      finished.completed_at = new Date().toISOString();
      finalData.completed.push(finished);
      saveTasks(finalData);
    }

    if (sendResult) {
      sendResult(`🏁 *Sprint build finished*\n\n_${description}_\n\nProject: ${projectDir}\nCheck the code and let me know if you want changes.`);
    }
  })();

  return { taskId, description };
}

module.exports = {
  launchTask,
  launchSprintTask,
  cancelTask,
  listActiveTasks,
  listRecentTasks,
  loadTasks
};
