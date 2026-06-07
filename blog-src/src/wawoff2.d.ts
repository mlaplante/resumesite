// `wawoff2` ships no type declarations. The OG-image route only uses
// `decompress` (WOFF2 → TTF bytes) at build time; declare just that surface.
declare module 'wawoff2' {
  export function decompress(input: Uint8Array | Buffer): Promise<Uint8Array>;
  export function compress(input: Uint8Array | Buffer): Promise<Uint8Array>;
}
