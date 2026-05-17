// Date formatting helpers — keep every page using the same display format so
// homepage / listing / detail pages don't drift apart.

const SHORT_OPTS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  timeZone: 'UTC',
};

const LONG_OPTS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
};

export function formatDateShort(date: Date): string {
  return date.toLocaleDateString('en-US', SHORT_OPTS);
}

export function formatDateLong(date: Date): string {
  return date.toLocaleDateString('en-US', LONG_OPTS);
}

export function formatDateISO(date: Date): string {
  return date.toISOString();
}
