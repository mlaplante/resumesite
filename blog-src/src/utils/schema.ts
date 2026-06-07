// Structured-data (JSON-LD) helpers.
//
// `safeJsonLd` is the security-critical piece: JSON-LD is injected into the
// page via `set:html` inside a `<script type="application/ld+json">` element.
// Plain `JSON.stringify` does NOT escape `<`, `>`, or `&`, so a post title,
// tag, or excerpt containing `</script>` (or a `<!--` sequence) would break
// out of the script context and allow HTML/script injection. We escape those
// characters — plus the U+2028/U+2029 line separators that are valid in JSON
// strings but illegal in raw JavaScript — to their `\uXXXX` forms, which are
// equivalent inside a JSON string but inert as markup.
export function safeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export interface Crumb {
  name: string;
  item: string;
}

// Build a schema.org BreadcrumbList object from an ordered list of crumbs.
// Positions are 1-based per the spec.
export function breadcrumbList(crumbs: Crumb[]) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((crumb, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: crumb.name,
      item: crumb.item,
    })),
  };
}
