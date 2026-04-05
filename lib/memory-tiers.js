/**
 * Tiered memory architecture for Nelson.
 *
 * Instead of dumping all of memory.json into every prompt, this module
 * categorises memory into tiers and selects only what's relevant:
 *
 * HOT  — Always included: core identity, current priorities, relationship
 * WARM — Included when relevant: people, companies, projects, life context
 * COLD — Only on demand: interests, media, books, films, system internals
 *
 * This reduces first-message token usage by 40-60% for typical conversations,
 * while ensuring Nelson still has full context when needed.
 */

const { loadMemory } = require('./memory');

// --- Tier definitions ---

/**
 * HOT tier keys — always included in every first-session message.
 * These are essential for Nelson's identity and behaviour.
 */
const HOT_KEYS = ['core', 'current_priorities', 'life_context'];

/**
 * WARM tier — included when the message content suggests relevance.
 * Each entry maps a memory key to trigger keywords.
 */
const WARM_TIERS = {
  people: {
    keys: ['people'],
    triggers: [] // dynamically populated from people names
  },
  companies: {
    keys: ['companies'],
    triggers: [] // dynamically populated from company names
  },
  angel_investments: {
    keys: ['angel_investments'],
    triggers: ['invest', 'angel', 'portfolio', 'deal', 'echo', 'seed', 'round', 'check', 'fund']
  },
  media: {
    keys: ['media'],
    triggers: ['press', 'article', 'featured', 'ibtimes', 'venturebeat', 'podcast', 'media', 'pr ', 'coverage']
  }
};

/**
 * COLD tier — only included when explicitly relevant.
 */
const COLD_TIERS = {
  interests: {
    keys: ['interests'],
    triggers: ['chess', 'watch', 'rolex', 'travel', 'bouldering', 'espresso', 'geocach', 'ice cream', 'hobby', 'hobbies', 'film', 'movie', 'book', 'read']
  },
  books_films: {
    keys: ['books_read', 'films_watched'],
    triggers: ['book', 'read', 'film', 'movie', 'watch', 'parasite', 'breaking bad', 'spare', 'horowitz']
  },
  nelson_system: {
    keys: ['nelson_system'],
    triggers: ['nelson system', 'how do you work', 'architecture', 'cron', 'autostart', 'github repo', 'integration', 'gmail status', 'calendar status', 'version', 'capabilities']
  }
};

/**
 * Build dynamic triggers from memory content.
 * Extracts people names and company names so they trigger warm-tier inclusion.
 */
function buildDynamicTriggers(memory) {
  // People triggers
  if (memory.people) {
    WARM_TIERS.people.triggers = Object.keys(memory.people)
      .flatMap(name => {
        const parts = name.toLowerCase().split(/\s+/);
        // Include full name and surname (if multi-word)
        return parts.length > 1 ? [name.toLowerCase(), parts[parts.length - 1]] : [name.toLowerCase()];
      });
  }

  // Company triggers
  if (memory.companies) {
    WARM_TIERS.companies.triggers = Object.keys(memory.companies)
      .map(name => name.toLowerCase());
  }
}

/**
 * Score relevance of a tier against user message.
 * Returns 0 (no match) to 1 (strong match).
 */
function scoreTier(tier, messageLower) {
  if (!tier.triggers || tier.triggers.length === 0) return 0;
  let matches = 0;
  for (const trigger of tier.triggers) {
    if (messageLower.includes(trigger)) matches++;
  }
  return Math.min(1, matches / Math.max(1, Math.ceil(tier.triggers.length * 0.1)));
}

/**
 * Select relevant memory for a given user message.
 *
 * @param {string} userMessage - The user's message text
 * @param {object} opts
 * @param {boolean} opts.full - If true, return everything (for special commands)
 * @param {string[]} opts.forceTiers - Force include these tier names
 * @returns {object} { memory: selectedMemory, tiers: includedTierNames, tokenEstimate: number }
 */
function selectMemory(userMessage, { full = false, forceTiers = [] } = {}) {
  const memory = loadMemory();

  if (full) {
    return {
      memory,
      tiers: ['all'],
      tokenEstimate: estimateTokens(memory)
    };
  }

  buildDynamicTriggers(memory);

  const selected = {};
  const includedTiers = ['hot'];
  const messageLower = (userMessage || '').toLowerCase();

  // Always include HOT tier
  for (const key of HOT_KEYS) {
    if (memory[key] !== undefined) {
      selected[key] = memory[key];
    }
  }

  // Include WARM tiers if relevant
  for (const [tierName, tier] of Object.entries(WARM_TIERS)) {
    const score = scoreTier(tier, messageLower);
    const forced = forceTiers.includes(tierName);
    if (score > 0 || forced) {
      includedTiers.push(tierName);
      for (const key of tier.keys) {
        if (memory[key] !== undefined) selected[key] = memory[key];
      }
    }
  }

  // Include COLD tiers only on strong match
  for (const [tierName, tier] of Object.entries(COLD_TIERS)) {
    const score = scoreTier(tier, messageLower);
    const forced = forceTiers.includes(tierName);
    if (score > 0.3 || forced) {
      includedTiers.push(tierName);
      for (const key of tier.keys) {
        if (memory[key] !== undefined) selected[key] = memory[key];
      }
    }
  }

  return {
    memory: selected,
    tiers: includedTiers,
    tokenEstimate: estimateTokens(selected)
  };
}

/**
 * Rough token estimate for a JSON object (~4 chars per token).
 */
function estimateTokens(obj) {
  return Math.round(JSON.stringify(obj).length / 4);
}

/**
 * Format memory for prompt injection — compact representation.
 */
function formatForPrompt(selectedMemory) {
  return JSON.stringify(selectedMemory);
}

/**
 * Get a summary of what tiers exist and their sizes.
 * Useful for health reports and debugging.
 */
function getTierStats() {
  const memory = loadMemory();
  buildDynamicTriggers(memory);

  const stats = { hot: {}, warm: {}, cold: {} };

  for (const key of HOT_KEYS) {
    if (memory[key]) stats.hot[key] = estimateTokens(memory[key]);
  }
  for (const [name, tier] of Object.entries(WARM_TIERS)) {
    let total = 0;
    for (const key of tier.keys) {
      if (memory[key]) total += estimateTokens(memory[key]);
    }
    stats.warm[name] = { tokens: total, triggerCount: tier.triggers.length };
  }
  for (const [name, tier] of Object.entries(COLD_TIERS)) {
    let total = 0;
    for (const key of tier.keys) {
      if (memory[key]) total += estimateTokens(memory[key]);
    }
    stats.cold[name] = { tokens: total, triggerCount: tier.triggers.length };
  }

  const fullTokens = estimateTokens(memory);
  const hotTokens = Object.values(stats.hot).reduce((a, b) => a + b, 0);

  return {
    ...stats,
    summary: {
      fullMemoryTokens: fullTokens,
      hotOnlyTokens: hotTokens,
      typicalSavings: `${Math.round((1 - hotTokens / fullTokens) * 100)}%`
    }
  };
}

module.exports = {
  selectMemory,
  formatForPrompt,
  getTierStats,
  estimateTokens,
  HOT_KEYS,
  WARM_TIERS,
  COLD_TIERS
};
