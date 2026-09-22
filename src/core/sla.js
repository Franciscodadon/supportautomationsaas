// First-response SLA, in calendar hours from ticket creation.
// Deliberately calendar-based, not business-hours: escalations are the tier that
// should not wait for Monday. Change these numbers here and nowhere else.
export const SLA_HOURS = { P1: 1, P2: 4, P3: 24, P4: 72 };

export const SEVERITIES = Object.keys(SLA_HOURS);

export const SEVERITY_LABELS = {
  P1: 'P1 - Critical (service down / revenue blocked)',
  P2: 'P2 - High (major feature broken, no workaround)',
  P3: 'P3 - Normal (broken with a workaround)',
  P4: 'P4 - Low (question, cosmetic, feature request)',
};

export function normalizeSeverity(input) {
  if (!input) return 'P3';
  const s = String(input).trim().toUpperCase();
  const direct = s.match(/^P([1-4])$/);
  if (direct) return `P${direct[1]}`;
  if (/CRITICAL|URGENT|DOWN|EMERGENC/.test(s)) return 'P1';
  if (/HIGH|MAJOR/.test(s)) return 'P2';
  if (/LOW|MINOR|COSMETIC|QUESTION|REQUEST/.test(s)) return 'P4';
  return 'P3';
}

export function firstResponseDueAt(severity, createdAt = new Date()) {
  const hours = SLA_HOURS[normalizeSeverity(severity)] ?? SLA_HOURS.P3;
  return new Date(createdAt.getTime() + hours * 3600_000);
}

/**
 * A ticket breaches when it has had no first response and its due time passed.
 * Once first_responded_at is set the first-response clock stops for good.
 */
export function isBreached(ticket, now = new Date()) {
  if (ticket.first_responded_at) return false;
  if (!ticket.first_response_due_at) return false;
  if (['resolved', 'closed'].includes(ticket.status)) return false;
  return new Date(ticket.first_response_due_at) < now;
}
