import { defineConfig } from 'astro/config';

export default defineConfig({
  outDir: '../blog',
  base: '/blog',
  output: 'static',
  build: {
    format: 'directory',
  },
  markdown: {
    shikiConfig: {
      themes: {
        light: 'github-light',
        dark: 'github-dark',
      },
      wrap: true,
    },
  },
});
