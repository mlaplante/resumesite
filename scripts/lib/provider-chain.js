/**
 * Ordered provider fallback for the blog-draft pipeline.
 *
 * One run makes several `generate()` calls (topic picks, the post, a title
 * retry). Each call goes to the current provider; when a provider throws, the
 * chain moves to the next one and STAYS there for the rest of the run, so a
 * dead provider costs one round of retries rather than one per call, and a
 * post and its retry come from the same voice.
 *
 * The last provider is terminal: whatever it does on failure (Gemini exits
 * the process) is final.
 */

export function createProviderChain(providers) {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new TypeError('createProviderChain requires at least one provider');
  }

  let index = 0;
  let lastServed = null;

  async function generate(args) {
    while (true) {
      const provider = providers[index];
      try {
        const text = await provider.generate(args);
        lastServed = { provider: provider.name, model: provider.currentModel?.() ?? null };
        return text;
      } catch (err) {
        if (index === providers.length - 1) throw err;
        const next = providers[index + 1].name;
        console.warn(`Provider ${provider.name} failed (${err.message}); falling back to ${next} for the rest of this run.`);
        index += 1;
      }
    }
  }

  return {
    generate,
    // Who answered the most recent call — after a successful run, that is the
    // call that wrote the post body.
    lastServed: () => lastServed,
  };
}
