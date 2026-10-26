import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  createGenerate,
  requestParams,
  AnthropicUnavailableError,
  MIN_MAX_TOKENS,
  POST_MAX_TOKENS,
} from '../../scripts/lib/anthropic.js';
import { createProviderChain } from '../../scripts/lib/provider-chain.js';

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'];

function message({ stop_reason = 'end_turn', text = 'TITLE: A Post\n\nBody.', stop_details = null } = {}) {
  return {
    stop_reason,
    stop_details,
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      ...(text ? [{ type: 'text', text }] : []),
    ],
  };
}

function apiError(status, msg = 'boom') {
  return Object.assign(new Error(msg), { status });
}

// Each entry is either a message to resolve or an Error to reject with.
function fakeClient(...responses) {
  const create = vi.fn(async () => {
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  });
  return { client: { messages: { create } }, create };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('anthropic requestParams', () => {
  it('raises short topic-pick budgets to the floor and uses low effort', () => {
    const p = requestParams({ model: 'm', system: 's', user: 'u', maxTokens: 120 });
    expect(p.max_tokens).toBe(MIN_MAX_TOKENS);
    expect(p.output_config).toEqual({ effort: 'low' });
  });

  it('gives full posts the post budget at high effort', () => {
    const p = requestParams({ model: 'm', system: 's', user: 'u' });
    expect(p.max_tokens).toBe(POST_MAX_TOKENS);
    expect(p.output_config).toEqual({ effort: 'high' });
  });

  it('never forwards temperature', () => {
    const p = requestParams({ model: 'm', system: 's', user: 'u', temperature: 0.7 });
    expect(p).not.toHaveProperty('temperature');
  });
});

describe('anthropic generate', () => {
  it('returns only text blocks from the primary model', async () => {
    const { client, create } = fakeClient(message({ text: 'hello' }));
    const onServed = vi.fn();
    const generate = createGenerate({ client, models: MODELS, onServed });

    await expect(generate({ system: 's', user: 'u' })).resolves.toBe('hello');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0].model).toBe('claude-opus-5-5');
    expect(onServed).toHaveBeenCalledWith('claude-opus-5-5');
  });

  it('falls back to Sonnet when Opus errors', async () => {
    const { client, create } = fakeClient(apiError(529, 'overloaded'), message({ text: 'from sonnet' }));
    const onServed = vi.fn();
    const generate = createGenerate({ client, models: MODELS, onServed });

    await expect(generate({ system: 's', user: 'u' })).resolves.toBe('from sonnet');
    expect(create.mock.calls.map(c => c[0].model)).toEqual(MODELS);
    expect(onServed).toHaveBeenCalledWith('claude-sonnet-5-5');
  });

  it.each([
    ['max_tokens', message({ stop_reason: 'max_tokens', text: 'half a po' })],
    ['refusal', message({ stop_reason: 'refusal', text: '', stop_details: { type: 'refusal', category: 'cyber' } })],
    ['empty end_turn', message({ text: '' })],
  ])('refuses a %s response and tries the next model', async (_label, bad) => {
    const { client } = fakeClient(bad, message({ text: 'clean' }));
    const generate = createGenerate({ client, models: MODELS });
    await expect(generate({ system: 's', user: 'u' })).resolves.toBe('clean');
  });

  it('throws AnthropicUnavailableError when every model fails', async () => {
    const { client } = fakeClient(apiError(500), message({ stop_reason: 'max_tokens' }));
    const generate = createGenerate({ client, models: MODELS });
    await expect(generate({ system: 's', user: 'u' })).rejects.toBeInstanceOf(AnthropicUnavailableError);
  });

  it('does not retry other models when the API key is rejected', async () => {
    const { client, create } = fakeClient(apiError(401, 'invalid x-api-key'));
    const generate = createGenerate({ client, models: MODELS });
    await expect(generate({ system: 's', user: 'u' })).rejects.toBeInstanceOf(AnthropicUnavailableError);
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('createProviderChain', () => {
  it('uses the first provider while it succeeds', async () => {
    const first = vi.fn(async () => 'a');
    const second = vi.fn(async () => 'b');
    const chain = createProviderChain([
      { name: 'anthropic', generate: first, currentModel: () => 'claude-opus-5-5' },
      { name: 'gemini', generate: second },
    ]);

    await expect(chain.generate({})).resolves.toBe('a');
    expect(second).not.toHaveBeenCalled();
    expect(chain.lastServed()).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' });
  });

  it('falls back and stays on the fallback for the rest of the run', async () => {
    const first = vi.fn(async () => { throw new AnthropicUnavailableError('down'); });
    const second = vi.fn(async () => 'b');
    const chain = createProviderChain([
      { name: 'anthropic', generate: first },
      { name: 'gemini', generate: second },
    ]);

    await expect(chain.generate({})).resolves.toBe('b');
    await expect(chain.generate({})).resolves.toBe('b');
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    expect(chain.lastServed()).toEqual({ provider: 'gemini', model: null });
  });

  it('rethrows when the last provider fails', async () => {
    const chain = createProviderChain([
      { name: 'only', generate: async () => { throw new Error('nope'); } },
    ]);
    await expect(chain.generate({})).rejects.toThrow('nope');
  });

  it('requires at least one provider', () => {
    expect(() => createProviderChain([])).toThrow(TypeError);
  });
});
