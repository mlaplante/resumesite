/**
 * Shared Anthropic Claude client.
 *
 * Mirrors scripts/lib/gemini.js: one `generate()` that walks a model fallback
 * chain and refuses any response that did not finish cleanly. The difference
 * is that this client THROWS when every model fails instead of exiting, so a
 * caller (scripts/lib/provider-chain.js) can fall through to Gemini.
 *
 * Environment:
 *   ANTHROPIC_API_KEY          - required (read by the SDK)
 *   ANTHROPIC_MODEL            - optional, defaults to "claude-opus-5-5"
 *   ANTHROPIC_FALLBACK_MODELS  - optional, comma-separated, defaults to "claude-sonnet-5-5"
 *   ANTHROPIC_POST_EFFORT      - optional, effort for full posts, defaults to "high"
 */

import Anthropic from '@anthropic-ai/sdk';

const PRIMARY_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
const FALLBACK_MODELS = (process.env.ANTHROPIC_FALLBACK_MODELS || 'claude-sonnet-5-5')
  .split(',').map(s => s.trim()).filter(Boolean);
export const MODELS = [PRIMARY_MODEL, ...FALLBACK_MODELS.filter(m => m !== PRIMARY_MODEL)];

// Opus 5.5 and Sonnet 5.5 always think, and thinking tokens count against
// `max_tokens`. The 100-120 token budgets the topic picker asks for (sized for
// Gemini with thinking disabled) would be spent before any answer is written,
// so every request gets at least this much room.
export const MIN_MAX_TOKENS = 4000;

// A full post with code examples runs 9-11k characters (~3k tokens) plus
// thinking. 16k is the largest budget that stays comfortably inside the SDK's
// non-streaming HTTP timeout.
export const POST_MAX_TOKENS = 16000;

// Calls asking for fewer tokens than this are short structured replies (topic
// picks): low effort is enough and keeps thinking from eating the budget.
const SHORT_CALL_TOKENS = 1000;
const POST_EFFORT = process.env.ANTHROPIC_POST_EFFORT || 'high';

// Every model in the chain shares one API key, so a bad or unauthorized key
// will fail them all identically — don't spend a request proving it twice.
const KEY_FAILURE_STATUS = new Set([401, 403]);

export class AnthropicUnavailableError extends Error {
  constructor(message, { causes = [] } = {}) {
    super(message);
    this.name = 'AnthropicUnavailableError';
    this.causes = causes;
  }
}

export function requestParams({ model, system, user, maxTokens }) {
  const short = maxTokens !== undefined && maxTokens < SHORT_CALL_TOKENS;
  // `temperature` is deliberately not forwarded: Opus 5.5 rejects it outright
  // and Sonnet 5.5 rejects any non-default value.
  return {
    model,
    max_tokens: short ? MIN_MAX_TOKENS : Math.max(maxTokens ?? POST_MAX_TOKENS, MIN_MAX_TOKENS),
    output_config: { effort: short ? 'low' : POST_EFFORT },
    system,
    messages: [{ role: 'user', content: user }],
  };
}

// Only text blocks are prose; thinking blocks come back with empty text by
// default and must never leak into a post.
function responseText(message) {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
    .trim();
}

// Build a `generate()` bound to a client. `onServed(model)` reports which model
// actually answered, so the workflow can say who wrote the draft.
export function createGenerate({ client, models = MODELS, onServed = () => {} } = {}) {
  let resolvedClient = client;

  return async function generate({ system, user, maxTokens }) {
    // Constructed lazily: the SDK throws on a missing key at construction, and
    // that must surface as a fall-through-able error, not an import crash.
    try {
      resolvedClient ??= new Anthropic({ maxRetries: 2, timeout: 10 * 60 * 1000 });
    } catch (err) {
      throw new AnthropicUnavailableError(`Anthropic client unavailable: ${err.message}`);
    }

    const causes = [];
    for (const model of models) {
      console.log(`Calling Anthropic model: ${model}`);
      let message;
      try {
        // The SDK already retries 408/409/429/5xx and connection errors.
        message = await resolvedClient.messages.create(requestParams({ model, system, user, maxTokens }));
      } catch (err) {
        const reason = `[${model}] ${err.status ?? 'error'}: ${err.message}`;
        causes.push(reason);
        if (KEY_FAILURE_STATUS.has(err.status)) {
          console.warn(`${reason} — API key rejected, skipping remaining Anthropic models.`);
          break;
        }
        console.warn(`${reason} — trying next model...`);
        continue;
      }

      // A response cut off by `max_tokens` (or declined with `refusal`) still
      // arrives as a 200 with partial text. Only a natural finish is usable —
      // this is the Anthropic twin of Gemini's finishReason check.
      const text = responseText(message);
      if (message.stop_reason === 'end_turn' && text) {
        onServed(model);
        return text;
      }

      const category = message.stop_details?.category;
      const reason = `[${model}] stop_reason=${message.stop_reason}${category ? ` (${category})` : ''}` +
        `${text ? '' : ', no text'}`;
      causes.push(reason);
      console.warn(`${reason} — refusing response, trying next model...`);
    }

    throw new AnthropicUnavailableError(
      `All Anthropic models failed: ${causes.join('; ')}`,
      { causes },
    );
  };
}

export const generate = createGenerate();
