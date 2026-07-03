import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import astro from 'eslint-plugin-astro';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'blog-src/node_modules/**',
      'blog-src/public/css/**',
      'blog-src/.astro/**',
      '.wrangler/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...astro.configs.recommended,

  // Node-side ESM: draft generators, PurgeCSS pass, tests, config files.
  {
    files: ['scripts/**/*.{js,mjs}', 'blog-src/scripts/**/*.mjs', 'tests/**/*.{js,ts}', '*.{js,ts,mjs}'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  // Cloudflare Worker runtime.
  {
    files: ['worker/**/*.ts'],
    languageOptions: {
      globals: { ...globals.serviceworker },
    },
  },

  // Browser scripts served from public/ — classic scripts, not modules.
  {
    files: ['blog-src/public/js/**/*.js'],
    languageOptions: {
      sourceType: 'script',
      globals: { ...globals.browser },
    },
  },

  // Astro components and site TS run through astro-eslint-parser / tsc.
  {
    files: ['blog-src/src/**/*.{ts,astro}'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },

  {
    rules: {
      // The Worker env interface and content schemas legitimately use
      // explicit `any` in a couple of narrow spots; prefer targeted disables.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
);
