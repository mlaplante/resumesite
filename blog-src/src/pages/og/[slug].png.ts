import type { APIContext, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import satori from 'satori';
import { Resvg } from '@resvg/resvg-js';
import { decompress } from 'wawoff2';

// Decompress the WOFF2 fonts that ship with the site to TTF at build time so
// satori can parse them. Done once per build, on demand, then memoized.
const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(here, '../../../public');

let fontCache: Array<{ name: string; data: Buffer; weight: 400 | 600; style: 'normal' }> | null = null;

// Copy the decompressed bytes into a fresh Buffer. Without this, Astro's
// Vite bundler somehow ends up presenting a corrupted view of the WASM-owned
// Uint8Array to satori across the prerender boundary, producing
// "Unsupported OpenType signature" errors.
function freshBuffer(u8: Uint8Array): Buffer {
  const buf = Buffer.alloc(u8.length);
  buf.set(u8);
  return buf;
}

async function loadFonts() {
  if (fontCache) return fontCache;
  const regular = readFileSync(`${PUBLIC}/fonts/poppins/poppins-400.woff2`);
  const semibold = readFileSync(`${PUBLIC}/fonts/poppins/poppins-600.woff2`);
  fontCache = [
    { name: 'Poppins', data: freshBuffer(await decompress(regular)), weight: 400, style: 'normal' },
    { name: 'Poppins', data: freshBuffer(await decompress(semibold)), weight: 600, style: 'normal' },
  ];
  return fontCache;
}

export const getStaticPaths = (async () => {
  const posts = await getCollection('posts');
  return posts.map((post) => ({
    params: { slug: post.id },
    props: { post },
  }));
}) satisfies GetStaticPaths;

// satori takes a React-like virtual node tree. We avoid pulling in React here
// by handcrafting the elements with `type`, `props`, `key`. The shape matches
// what satori expects for plain DOM elements.
type SatoriNode = {
  type: string;
  props: Record<string, unknown> & { children?: SatoriNode | SatoriNode[] | string };
};

function el(type: string, props: SatoriNode['props']): SatoriNode {
  return { type, props };
}

function buildCard(title: string, category: string, date: string): SatoriNode {
  return el('div', {
    style: {
      width: 1200,
      height: 630,
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'space-between',
      background: 'linear-gradient(135deg, #1a5276 0%, #2980b9 100%)',
      padding: '72px 80px',
      fontFamily: 'Poppins',
      color: '#ffffff',
    },
    children: [
      el('div', {
        style: {
          display: 'flex',
          fontSize: 24,
          fontWeight: 400,
          letterSpacing: 3,
          textTransform: 'uppercase',
          opacity: 0.85,
        },
        children: 'michaellaplante.com',
      }),
      el('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        },
        children: [
          el('div', {
            style: {
              fontSize: 60,
              fontWeight: 600,
              lineHeight: 1.15,
              letterSpacing: -1,
              display: 'flex',
            },
            // satori has a 1500-char title soft cap; truncate well before that
            // to keep the layout from overflowing the card height.
            children: title.length > 160 ? title.slice(0, 158) + '…' : title,
          }),
          el('div', {
            style: {
              display: 'flex',
              gap: 24,
              fontSize: 22,
              opacity: 0.8,
              fontWeight: 400,
            },
            children: [
              el('span', { style: { display: 'flex' }, children: category.replace(/-/g, ' ') }),
              el('span', { style: { display: 'flex' }, children: '·' }),
              el('span', { style: { display: 'flex' }, children: date }),
            ],
          }),
        ],
      }),
    ],
  });
}

export async function GET({ props }: APIContext) {
  // Astro types `props` as `Record<string, any>` from getStaticPaths — narrow it.
  const post = (props as { post: { data: { title: string; category: string; date: Date } } }).post;
  const fonts = await loadFonts();

  const card = buildCard(
    post.data.title,
    post.data.category,
    post.data.date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }),
  );

  // Cast: satori's JSX type expects a React element shape. Our handcrafted
  // node uses the same field layout, but TS can't prove the equivalence.
  const svg = await satori(card as unknown as Parameters<typeof satori>[0], {
    width: 1200,
    height: 630,
    fonts,
  });

  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1200 },
  }).render().asPng();

  // Use a fresh ArrayBuffer-backed Uint8Array so Response can accept it as a
  // BodyInit without TS complaints.
  const body = new Uint8Array(png);
  return new Response(body, {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=604800, immutable',
    },
  });
}
