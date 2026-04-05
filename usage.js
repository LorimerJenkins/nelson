const fs = require('fs');
const path = require('path');

const USAGE_FILE = path.join(__dirname, 'usage.json');

function loadUsage() {
  try { return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); }
  catch { return { calls: [], limit_hits: [] }; }
}

function saveUsage(data) {
  fs.writeFileSync(USAGE_FILE, JSON.stringify(data, null, 2));
}

// Log a Claude call
function logCall(type, estimatedTokens = 0) {
  const data = loadUsage();
  data.calls.push({
    timestamp: new Date().toISOString(),
    type, // 'message', 'session_name', 'health_check', 'error_diagnosis', 'memory_update'
    estimated_tokens: estimatedTokens
  });
  // Keep last 7 days of data
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  data.calls = data.calls.filter(c => c.timestamp > weekAgo);
  saveUsage(data);
}

// Log when we actually hit the limit
function logLimitHit() {
  const data = loadUsage();
  data.limit_hits.push({
    timestamp: new Date().toISOString(),
    calls_before_hit: getTodayCalls().length
  });
  // Keep last 30 limit hits for calibration
  if (data.limit_hits.length > 30) data.limit_hits = data.limit_hits.slice(-30);
  saveUsage(data);
}

function getTodayCalls() {
  const data = loadUsage();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  return data.calls.filter(c => new Date(c.timestamp) >= todayStart);
}

// Estimate the daily limit based on past limit hits
function estimateDailyLimit() {
  const data = loadUsage();
  if (data.limit_hits.length === 0) {
    // No data yet — use a conservative default
    // Claude Max with Claude Code typically allows roughly 45-80 messages depending on complexity
    return { estimated_limit: 60, confidence: 'low', source: 'default' };
  }
  // Average the calls_before_hit from recent limit hits
  const recent = data.limit_hits.slice(-10);
  const avg = Math.round(recent.reduce((sum, h) => sum + h.calls_before_hit, 0) / recent.length);
  return { estimated_limit: avg, confidence: recent.length >= 5 ? 'high' : 'medium', source: 'calibrated' };
}

// Get current usage stats
function getUsageStats() {
  const todayCalls = getTodayCalls();
  const { estimated_limit, confidence } = estimateDailyLimit();
  const used = todayCalls.length;
  const percentage = Math.min(100, Math.round((used / estimated_limit) * 100));

  // Breakdown by type
  const breakdown = {};
  for (const call of todayCalls) {
    breakdown[call.type] = (breakdown[call.type] || 0) + 1;
  }

  // Hourly rate
  const now = new Date();
  const hoursElapsed = Math.max(0.5, (now.getHours() + now.getMinutes() / 60));
  const rate = Math.round((used / hoursElapsed) * 10) / 10;

  // Estimated time remaining
  let estimatedTimeLeft = null;
  if (rate > 0 && used < estimated_limit) {
    const remaining = estimated_limit - used;
    const hoursLeft = remaining / rate;
    estimatedTimeLeft = hoursLeft;
  }

  return {
    used,
    estimated_limit,
    percentage,
    confidence,
    breakdown,
    rate_per_hour: rate,
    estimated_hours_left: estimatedTimeLeft
  };
}

// Generate a visual usage bar for Telegram
function usageBar(percentage) {
  const total = 20;
  const filled = Math.round((percentage / 100) * total);
  const empty = total - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);

  let emoji;
  if (percentage < 50) emoji = '🟢';
  else if (percentage < 75) emoji = '🟡';
  else if (percentage < 90) emoji = '🟠';
  else emoji = '🔴';

  return `${emoji} ${bar} ${percentage}%`;
}

// Format full usage report for Telegram
function formatUsageReport() {
  const stats = getUsageStats();
  const bar = usageBar(stats.percentage);

  let report = `*Usage Today*\n\n${bar}\n\n`;
  report += `Messages: ${stats.used} / ~${stats.estimated_limit} (${stats.confidence} estimate)\n`;
  report += `Rate: ${stats.rate_per_hour} messages/hour\n`;

  if (stats.estimated_hours_left !== null) {
    const hrs = Math.floor(stats.estimated_hours_left);
    const mins = Math.round((stats.estimated_hours_left - hrs) * 60);
    report += `Estimated time left: ${hrs}h ${mins}m\n`;
  } else if (stats.percentage >= 100) {
    report += `Limit likely reached — waiting for reset\n`;
  }

  // Breakdown
  const types = Object.entries(stats.breakdown);
  if (types.length > 0) {
    report += `\n*Breakdown:*\n`;
    for (const [type, count] of types.sort((a, b) => b[1] - a[1])) {
      report += `  ${type}: ${count}\n`;
    }
  }

  return report;
}

// Check if we should warn about approaching limit
function shouldWarn() {
  const stats = getUsageStats();
  return stats.percentage >= 80 && stats.percentage < 100;
}

function getWarningMessage() {
  const stats = getUsageStats();
  if (stats.percentage >= 90) {
    return `⚠️ Usage at ${stats.percentage}% — likely hitting the limit soon. Keep messages focused.`;
  } else if (stats.percentage >= 80) {
    return `Usage at ${stats.percentage}% — getting close to the daily limit.`;
  }
  return null;
}

module.exports = {
  logCall,
  logLimitHit,
  getUsageStats,
  formatUsageReport,
  usageBar,
  shouldWarn,
  getWarningMessage,
  getTodayCalls,
  estimateDailyLimit
};
