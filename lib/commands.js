/**
 * Command router for Nelson — replaces the massive if/else chain
 * with a clean, extensible registration system.
 *
 * Commands are matched by exact keyword or pattern. Each command
 * gets a handler function that receives (ctx, { sendReply, text, ...helpers }).
 *
 * Usage:
 *   const router = new CommandRouter();
 *   router.command('status', 'Show bot status', async (ctx, h) => { ... });
 *   router.pattern(/^@dev\s+(.+)/i, 'Dev task', async (ctx, h, match) => { ... });
 *   const handled = await router.handle(ctx, text, helpers);
 */

const log = require('./logger').child({ component: 'commands' });

class CommandRouter {
  constructor() {
    // Exact keyword commands (lowercase)
    this.commands = new Map();
    // Regex pattern commands (checked in order)
    this.patterns = [];
  }

  /**
   * Register an exact keyword command.
   * @param {string|string[]} keywords - Keyword(s) that trigger this command
   * @param {string} description - For help text
   * @param {Function} handler - async (ctx, helpers) => void
   */
  command(keywords, description, handler) {
    const keys = Array.isArray(keywords) ? keywords : [keywords];
    for (const key of keys) {
      this.commands.set(key.toLowerCase(), { description, handler, keywords: keys });
    }
  }

  /**
   * Register a pattern-based command.
   * @param {RegExp} pattern - Regex to match against full message text
   * @param {string} description - For help text
   * @param {Function} handler - async (ctx, helpers, match) => void
   */
  pattern(pattern, description, handler) {
    this.patterns.push({ pattern, description, handler });
  }

  /**
   * Try to handle a message. Returns true if a command matched.
   * @param {object} ctx - Telegraf context
   * @param {string} text - Message text
   * @param {object} helpers - Shared helpers passed to handlers
   * @returns {boolean} true if handled
   */
  async handle(ctx, text, helpers) {
    const lower = text.toLowerCase().trim();

    // Check exact commands first
    const cmd = this.commands.get(lower);
    if (cmd) {
      log.info('Command matched', { command: lower });
      try {
        await cmd.handler(ctx, helpers);
      } catch (err) {
        log.error('Command handler error', { command: lower, err: err.message });
        await helpers.sendReply(ctx, 'Command failed — check logs.').catch(() => {});
      }
      return true;
    }

    // Check pattern commands
    for (const { pattern, handler, description } of this.patterns) {
      const match = text.match(pattern);
      if (match) {
        log.info('Pattern matched', { pattern: description });
        try {
          await handler(ctx, helpers, match);
        } catch (err) {
          log.error('Pattern handler error', { pattern: description, err: err.message });
          await helpers.sendReply(ctx, 'Command failed — check logs.').catch(() => {});
        }
        return true;
      }
    }

    return false;
  }

  /**
   * Get list of all registered commands for help text.
   */
  listCommands() {
    const seen = new Set();
    const cmds = [];
    for (const [key, { description, keywords }] of this.commands) {
      const id = keywords.join(',');
      if (seen.has(id)) continue;
      seen.add(id);
      cmds.push({ keywords, description });
    }
    return cmds;
  }
}

module.exports = { CommandRouter };
