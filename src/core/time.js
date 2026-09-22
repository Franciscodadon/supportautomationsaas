/** All timestamps in this service are stored as ISO-8601 UTC strings. */
export const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export const toIso = (d) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');

export const parseIso = (s) => (s ? new Date(s) : null);

export function hoursBetween(a, b) {
  if (!a || !b) return null;
  return (new Date(b) - new Date(a)) / 3600_000;
}

/** Start of the UTC day, N days back. */
export function daysAgoIso(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  d.setUTCHours(0, 0, 0, 0);
  return toIso(d);
}
