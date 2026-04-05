/**
 * Message queue for Nelson — processes messages sequentially to prevent
 * race conditions when Lorimer sends multiple messages rapidly.
 *
 * Features:
 * - FIFO ordering — messages processed in arrival order
 * - Concurrency control — one message at a time (configurable)
 * - Timeout protection — stuck messages get ejected
 * - Queue depth limit — prevents unbounded growth
 * - Stats for health reports
 */

const log = require('./logger').child({ component: 'queue' });

class MessageQueue {
  /**
   * @param {object} opts
   * @param {number} opts.concurrency - Max parallel handlers (default 1)
   * @param {number} opts.maxDepth - Max queued messages before dropping (default 20)
   * @param {number} opts.timeout - Per-message timeout in ms (default 5 min)
   */
  constructor({ concurrency = 1, maxDepth = 20, timeout = 300000 } = {}) {
    this.concurrency = concurrency;
    this.maxDepth = maxDepth;
    this.timeout = timeout;
    this.queue = [];
    this.active = 0;
    this.stats = {
      processed: 0,
      dropped: 0,
      timeouts: 0,
      errors: 0,
      maxQueueDepth: 0,
    };
  }

  /**
   * Enqueue a message for processing.
   * @param {Function} handler - Async function to process the message
   * @param {object} meta - Metadata for logging (msgId, text preview, etc.)
   * @returns {boolean} true if queued, false if dropped
   */
  enqueue(handler, meta = {}) {
    if (this.queue.length >= this.maxDepth) {
      this.stats.dropped++;
      log.warn('Message dropped — queue full', { depth: this.queue.length, ...meta });
      return false;
    }

    this.queue.push({ handler, meta, enqueuedAt: Date.now() });
    if (this.queue.length > this.stats.maxQueueDepth) {
      this.stats.maxQueueDepth = this.queue.length;
    }

    log.debug('Message queued', { depth: this.queue.length, active: this.active, ...meta });
    this._drain();
    return true;
  }

  /**
   * Process queued messages up to concurrency limit.
   */
  _drain() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      this.active++;
      this._process(item);
    }
  }

  async _process(item) {
    const { handler, meta, enqueuedAt } = item;
    const waitMs = Date.now() - enqueuedAt;

    if (waitMs > 100) {
      log.info('Message dequeued after wait', { waitMs, ...meta });
    }

    let timer;
    try {
      const result = await Promise.race([
        handler(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('QUEUE_TIMEOUT')), this.timeout);
        }),
      ]);
      clearTimeout(timer);
      this.stats.processed++;
    } catch (err) {
      clearTimeout(timer);
      if (err.message === 'QUEUE_TIMEOUT') {
        this.stats.timeouts++;
        log.error('Message handler timed out', { ...meta });
      } else {
        this.stats.errors++;
        log.error('Message handler error', { err: err.message, ...meta });
      }
    } finally {
      this.active--;
      this._drain();
    }
  }

  /**
   * Get queue stats for health reports.
   */
  getStats() {
    return {
      ...this.stats,
      currentDepth: this.queue.length,
      active: this.active,
    };
  }

  /**
   * Check if the queue is currently processing.
   */
  isBusy() {
    return this.active > 0 || this.queue.length > 0;
  }
}

module.exports = { MessageQueue };
