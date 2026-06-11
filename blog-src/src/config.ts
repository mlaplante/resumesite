export const SITE_URL = 'https://michaellaplante.com';
export const DEFAULT_OG_IMAGE = `${SITE_URL}/images/mike-laplante-400.jpg`;

// Author / brand identity. Centralized so JSON-LD, feeds, and meta tags share
// one source of truth instead of repeating the strings per page.
export const AUTHOR_NAME = 'Michael LaPlante';

// Blog feed metadata — used by the RSS feed, JSON Feed, and <head> feed
// autodiscovery links so the title/description can't drift between them.
export const BLOG_TITLE = "Michael LaPlante's Blog";
export const BLOG_DESCRIPTION = 'Thoughts on security, engineering, and building things.';

// Cal.com booking handle for the inline scheduler on /services — either a
// plain username ('mlaplante') or 'username/event-type' for a specific event.
// Set to '' to hide every piece of booking UI until an account exists.
export const CAL_LINK = 'mlaplante';
