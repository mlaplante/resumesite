/**
 * Shared Google Gemini client.
 *
 * Every caller goes through `generate()` so the finish-reason enforcement
 * lives in exactly one place: a response cut short by the output-token cap
 * comes back as HTTP 200 with partial text, and the only tell is
 * `finishReason: "MAX_TOKENS"`. Not checking it is what published 65
 * half-finished posts (see scripts/repair-truncated-posts.js).
 *
 * Environment:
 *   GEMINI_API_KEY          - required
 *   GEMINI_MODEL            - optional, defaults to "gemini-2.5-flash"
 *   GEMINI_FALLBACK_MODELS  - optional, comma-separated fallback chain
 *   GEMINI_EMBED_MODEL      - optional, defaults to "gemini-embedding-001"
 *   GEMINI_MAX_TOKENS       - optional, output budget for a full post
 */

const PRIMARY_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const FALLBACK_MODELS = (process.env.GEMINI_FALLBACK_MODELS || 'gemini-3.6-flash,gemini-2.5-flash-lite')
  .split(',').map(s => s.trim()).filter(Boolean);
const MODELS = [PRIMARY_MODEL, ...FALLBACK_MODELS.filter(m => m !== PRIMARY_MODEL)];
const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || 'gemini-embedding-001';
const apiUrlFor = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const embedUrlFor = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`;

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MODEL_UNAVAILABLE_STATUS = new Set([400, 404]);
const RETRY_DELAYS = [2000, 5000];

// A full technical post with worked code examples runs 9-11k characters, which
// overran the previous 2500-token budget constantly: Gemini would return HTTP
// 200 with a body cut mid-identifier and the pipeline published it. 8000 leaves
// real headroom (gemini-2.5-flash allows far more), so the cap is no longer the
// binding constraint on a finished post.
export const POST_MAX_TOKENS = Number(process.env.GEMINI_MAX_TOKENS || 8000);

// One escalation before giving up, for the rare post that still runs long.
const MAX_TOKENS_RETRY_FACTOR = 2;

async function requestCompletion({ system, user, maxTokens, temperature }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error('Error: GEMINI_API_KEY environment variable is required.');
    process.exit(1);
  }

  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature,
      // Disable Gemini 2.5 Flash "thinking" so reasoning tokens don't eat the output budget.
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  let lastErr = '';
  for (const model of MODELS) {
    console.log(`Calling Gemini model: ${model}`);

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      const res = await fetch(apiUrlFor(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body,
      });

      if (res.ok) {
        const data = await res.json();
        const candidate = data?.candidates?.[0];
        const text = candidate?.content?.parts?.map(p => p.text).filter(Boolean).join('') || '';
        const finishReason = candidate?.finishReason ?? 'UNSPECIFIED';
        if (text) return { text, finishReason, usage: data?.usageMetadata };
        console.error('Gemini API returned no text. Full response:', JSON.stringify(data));
        process.exit(1);
      }

      lastErr = `[${model}] ${res.status}: ${await res.text()}`;

      // Model retired / unknown / doesn't accept this request shape — skip to
      // the next model instead of aborting, so one stale name in the chain
      // can't kill the whole run.
      if (MODEL_UNAVAILABLE_STATUS.has(res.status)) {
        console.warn(`Gemini API error ${lastErr}`);
        console.warn(`[${model}] unavailable, trying next fallback model...`);
        break;
      }

      // Other non-retryable errors (e.g., 401/403 auth) — fail fast.
      if (!RETRYABLE_STATUS.has(res.status)) {
        console.error(`Gemini API error ${lastErr}`);
        process.exit(1);
      }

      if (attempt === RETRY_DELAYS.length) {
        console.warn(`[${model}] retries exhausted, trying next fallback model...`);
        break;
      }

      const wait = RETRY_DELAYS[attempt];
      console.warn(`[${model}] ${res.status}, retrying in ${wait}ms (attempt ${attempt + 1}/${RETRY_DELAYS.length})...`);
      await new Promise(r => setTimeout(r, wait));
    }
  }

  console.error(`All Gemini models exhausted. Last error: ${lastErr}`);
  process.exit(1);
}

// `requestCompletion` happily returns a partial body: when Gemini hits
// maxOutputTokens it still answers 200, and the only signal that the text was
// cut is `finishReason: "MAX_TOKENS"`. Ignoring that field is what published 65
// half-finished posts. Escalate the budget once, then fail the run outright —
// a missing draft is a non-event, a truncated published post is not.
export async function generate({ system, user, maxTokens = POST_MAX_TOKENS, temperature = 0.7 }) {
  let budget = maxTokens;

  for (let attempt = 0; attempt < 2; attempt++) {
    const { text, finishReason, usage } = await requestCompletion({
      system,
      user,
      maxTokens: budget,
      temperature,
    });

    if (finishReason === 'STOP') return text;

    if (finishReason === 'MAX_TOKENS') {
      const used = usage?.candidatesTokenCount ?? '?';
      // A model that ignores `thinkingBudget: 0` burns the budget on reasoning
      // tokens before emitting any prose, so surface that count too.
      const thoughts = usage?.thoughtsTokenCount;
      console.warn(
        `Response hit MAX_TOKENS (budget ${budget}, output ${used}` +
          `${thoughts ? `, thinking ${thoughts}` : ''}).`,
      );
      if (attempt === 0) {
        budget *= MAX_TOKENS_RETRY_FACTOR;
        console.warn(`Retrying once with maxOutputTokens=${budget}...`);
        continue;
      }
      console.error(
        `Refusing to write a truncated post: still hitting MAX_TOKENS at ${budget} tokens.`,
      );
      process.exit(1);
    }

    // SAFETY, RECITATION, and friends also yield partial text. None of them
    // should ever be published, so treat every non-STOP reason as fatal.
    console.error(`Refusing to use response with finishReason=${finishReason}.`);
    process.exit(1);
  }

  // Unreachable today — every branch above returns or exits — but falling out
  // of the loop would hand callers `undefined`, which surfaces much later as an
  // opaque TypeError. Fail loudly instead.
  console.error('Refusing to use response: exhausted attempts without a STOP finish.');
  process.exit(1);
}

// Embedding adapter: a tiny single-shot fetch — no retry, no fallback to a
// different embedding model, since `findMostSimilarSemantic` already falls
// back to lexical Jaccard if this throws.
export async function embed(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY missing');
  const res = await fetch(embedUrlFor(EMBED_MODEL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      content: { parts: [{ text }] },
    }),
  });
  if (!res.ok) {
    throw new Error(`embed ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  const values = data?.embedding?.values;
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('embed response missing values');
  }
  return values;
}
embed.model = EMBED_MODEL;
