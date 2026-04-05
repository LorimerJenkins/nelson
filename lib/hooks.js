/**
 * hooks.js — Error recovery hook system for Nelson
 *
 * Provides structured error handling with:
 * - Automatic retry with exponential backoff
 * - Circuit breaker to prevent cascading failures
 * - Error classification and recovery strategies
 * - Pre/post/error hooks around critical operations
 */

const fs = require('fs');
const path = require('path');

// --- Error Classification ---

const ERROR_TYPES = {
  SESSION_CORRUPT: 'session_corrupt',
  TIMEOUT: 'timeout',
  RATE_LIMIT: 'rate_limit',
  NETWORK: 'network',
  MEMORY_CORRUPT: 'memory_corrupt',
  PROCESS_CRASH: 'process_crash',
  BOT_FRAMEWORK: 'bot_framework',
  UNKNOWN: 'unknown'
};

/**
 * Classify an error into a known type based on its message/properties
 */
function classifyError(err) {
  const msg = (err.message || '') + (err.stderr || '') + (err.stdout || '');
  const lower = msg.toLowerCase();

  if (err.sessionFailed || lower.includes('conversation not found') || lower.includes('session')) {
    return ERROR_TYPES.SESSION_CORRUPT;
  }
  if (err.message === 'NELSON_TIMEOUT' || lower.includes('etimedout') || lower.includes('timed out') || err.killed) {
    return ERROR_TYPES.TIMEOUT;
  }
  if (lower.includes('usage') || lower.includes('rate') || lower.includes('limit') || lower.includes('capacity') || lower.includes('429')) {
    return ERROR_TYPES.RATE_LIMIT;
  }
  if (lower.includes('econnreset') || lower.includes('econnrefused') || lower.includes('network') || lower.includes('socket') || lower.includes('fetch')) {
    return ERROR_TYPES.NETWORK;
  }
  if (lower.includes('json') && (lower.includes('parse') || lower.includes('syntax'))) {
    return ERROR_TYPES.MEMORY_CORRUPT;
  }
  if (lower.includes('409') || lower.includes('conflict')) {
    return ERROR_TYPES.BOT_FRAMEWORK;
  }
  return ERROR_TYPES.UNKNOWN;
}

// --- Circuit Breaker ---

class CircuitBreaker {
  /**
   * @param {string} name - Identifier for this breaker
   * @param {object} opts
   * @param {number} opts.threshold - Failures before opening (default 5)
   * @param {number} opts.resetTimeout - Ms before trying again (default 60s)
   */
  constructor(name, { threshold = 5, resetTimeout = 60000 } = {}) {
    this.name = name;
    this.threshold = threshold;
    this.resetTimeout = resetTimeout;
    this.failures = 0;
    this.state = 'closed'; // closed = normal, open = blocking, half-open = testing
    this.lastFailure = 0;
    this.lastError = null;
  }

  /** Check if the circuit allows a call */
  canExecute() {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      // Check if reset timeout has elapsed
      if (Date.now() - this.lastFailure >= this.resetTimeout) {
        this.state = 'half-open';
        return true;
      }
      return false;
    }
    // half-open — allow one test call
    return true;
  }

  /** Record a success — reset the breaker */
  recordSuccess() {
    this.failures = 0;
    this.state = 'closed';
    this.lastError = null;
  }

  /** Record a failure — may trip the breaker */
  recordFailure(err) {
    this.failures++;
    this.lastFailure = Date.now();
    this.lastError = err;
    if (this.failures >= this.threshold) {
      this.state = 'open';
    }
  }

  /** Get status for health reports */
  status() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      lastError: this.lastError ? this.lastError.message : null,
      lastFailure: this.lastFailure ? new Date(this.lastFailure).toISOString() : null
    };
  }
}

// --- Retry with Exponential Backoff ---

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Async function to retry
 * @param {object} opts
 * @param {number} opts.maxRetries - Max attempts (default 3)
 * @param {number} opts.baseDelay - Initial delay in ms (default 1000)
 * @param {number} opts.maxDelay - Max delay cap in ms (default 30000)
 * @param {Function} opts.shouldRetry - (err, attempt) => bool, whether to retry
 * @param {Function} opts.onRetry - (err, attempt) => void, called before each retry
 * @returns {Promise<*>} Result of fn
 */
async function retryWithBackoff(fn, {
  maxRetries = 3,
  baseDelay = 1000,
  maxDelay = 30000,
  shouldRetry = () => true,
  onRetry = () => {}
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxRetries || !shouldRetry(err, attempt)) {
        throw err;
      }
      const delay = Math.min(baseDelay * Math.pow(2, attempt) + Math.random() * 500, maxDelay);
      onRetry(err, attempt, delay);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// --- Hook Registry ---

class HookRegistry {
  constructor() {
    // Hooks: { operationName: { before: [fn], after: [fn], error: [fn] } }
    this.hooks = {};
    // Circuit breakers per operation
    this.breakers = {};
    // Recovery strategies per error type
    this.recoveryStrategies = {};
    // Stats
    this.stats = {
      totalCalls: 0,
      totalErrors: 0,
      totalRecoveries: 0,
      errorsByType: {}
    };
  }

  /**
   * Register a hook for an operation
   * @param {string} operation - e.g. 'claude_call', 'memory_write', 'telegram_send'
   * @param {'before'|'after'|'error'} phase
   * @param {Function} fn - Hook function. Error hooks receive (err, context) and can return a recovery value.
   */
  on(operation, phase, fn) {
    if (!this.hooks[operation]) {
      this.hooks[operation] = { before: [], after: [], error: [] };
    }
    this.hooks[operation][phase].push(fn);
  }

  /**
   * Register a recovery strategy for an error type
   * @param {string} errorType - From ERROR_TYPES
   * @param {Function} strategy - (err, context) => Promise<recoveryResult|null>
   */
  recover(errorType, strategy) {
    this.recoveryStrategies[errorType] = strategy;
  }

  /**
   * Get or create a circuit breaker for an operation
   */
  breaker(operation, opts) {
    if (!this.breakers[operation]) {
      this.breakers[operation] = new CircuitBreaker(operation, opts);
    }
    return this.breakers[operation];
  }

  /**
   * Execute an operation with hooks, circuit breaker, and error recovery
   * @param {string} operation - Operation name
   * @param {Function} fn - The actual operation (async)
   * @param {object} context - Context passed to hooks (e.g. { sessionName, text, memory })
   * @returns {Promise<*>} Result of fn, or recovery result
   */
  async execute(operation, fn, context = {}) {
    this.stats.totalCalls++;
    const cb = this.breakers[operation];

    // Circuit breaker check
    if (cb && !cb.canExecute()) {
      const err = new Error(`Circuit breaker open for "${operation}" — ${cb.failures} recent failures. Last: ${cb.lastError?.message || 'unknown'}`);
      err.circuitOpen = true;
      throw err;
    }

    // Run before hooks
    const beforeHooks = this.hooks[operation]?.before || [];
    for (const hook of beforeHooks) {
      try { await hook(context); } catch (e) {
        console.error(`Before hook failed for ${operation}:`, e.message);
      }
    }

    try {
      const result = await fn();

      // Record success on circuit breaker
      if (cb) cb.recordSuccess();

      // Run after hooks
      const afterHooks = this.hooks[operation]?.after || [];
      for (const hook of afterHooks) {
        try { await hook(result, context); } catch (e) {
          console.error(`After hook failed for ${operation}:`, e.message);
        }
      }

      return result;
    } catch (err) {
      this.stats.totalErrors++;
      const errorType = classifyError(err);
      this.stats.errorsByType[errorType] = (this.stats.errorsByType[errorType] || 0) + 1;

      // Record failure on circuit breaker
      if (cb) cb.recordFailure(err);

      // Run error hooks
      const errorHooks = this.hooks[operation]?.error || [];
      for (const hook of errorHooks) {
        try {
          const recovery = await hook(err, context);
          if (recovery !== undefined && recovery !== null) {
            this.stats.totalRecoveries++;
            return recovery; // Hook recovered — return its result
          }
        } catch (hookErr) {
          console.error(`Error hook failed for ${operation}:`, hookErr.message);
        }
      }

      // Try recovery strategy based on error type
      const strategy = this.recoveryStrategies[errorType];
      if (strategy) {
        try {
          const recovery = await strategy(err, context);
          if (recovery !== undefined && recovery !== null) {
            this.stats.totalRecoveries++;
            return recovery;
          }
        } catch (strategyErr) {
          console.error(`Recovery strategy failed for ${errorType}:`, strategyErr.message);
        }
      }

      // No recovery — rethrow
      throw err;
    }
  }

  /** Get stats for health reports */
  getStats() {
    const breakerStatuses = {};
    for (const [name, cb] of Object.entries(this.breakers)) {
      breakerStatuses[name] = cb.status();
    }
    return {
      ...this.stats,
      circuitBreakers: breakerStatuses
    };
  }

  /** Reset stats (e.g. daily) */
  resetStats() {
    this.stats = { totalCalls: 0, totalErrors: 0, totalRecoveries: 0, errorsByType: {} };
  }
}

// --- Singleton instance with default recovery strategies ---

const hooks = new HookRegistry();

// Default circuit breakers
hooks.breaker('claude_call', { threshold: 5, resetTimeout: 120000 }); // 2min cooldown after 5 failures
hooks.breaker('telegram_send', { threshold: 10, resetTimeout: 30000 }); // 30s cooldown after 10 failures
hooks.breaker('memory_write', { threshold: 3, resetTimeout: 60000 }); // 1min cooldown after 3 failures

// --- Built-in Recovery Strategies ---

// Rate limit: just mark it, caller handles the wait
hooks.recover(ERROR_TYPES.RATE_LIMIT, async (err, context) => {
  console.log('Rate limit hit — signalling caller to back off');
  // Return null to let the error propagate — caller should handle rate limits
  // with their own backoff logic (e.g. sprint runner waits 30min)
  return null;
});

// Network errors: these are usually transient, suggest retry
hooks.recover(ERROR_TYPES.NETWORK, async (err, context) => {
  console.log('Network error detected — transient, retry recommended');
  // Return null — retryWithBackoff at call site handles this
  return null;
});

// Memory corruption: restore from backup if available
hooks.recover(ERROR_TYPES.MEMORY_CORRUPT, async (err, context) => {
  const MEMORY_FILE = context.memoryFile;
  if (!MEMORY_FILE) return null;

  const backupFile = MEMORY_FILE + '.backup';
  try {
    if (fs.existsSync(backupFile)) {
      console.log('Memory corrupted — restoring from backup');
      const backup = JSON.parse(fs.readFileSync(backupFile, 'utf8'));
      fs.writeFileSync(MEMORY_FILE, JSON.stringify(backup, null, 2));
      return backup; // Return restored memory
    }
  } catch (restoreErr) {
    console.error('Backup restore failed:', restoreErr.message);
  }
  return null;
});

module.exports = {
  hooks,
  HookRegistry,
  CircuitBreaker,
  retryWithBackoff,
  classifyError,
  ERROR_TYPES
};
