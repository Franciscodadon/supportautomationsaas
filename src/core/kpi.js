import { getDb } from '../db/index.js';
import { daysAgoIso, nowIso } from './time.js';

const median = (nums) => {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};
const round = (n, p = 1) => (n === null || n === undefined ? null : Number(n.toFixed(p)));

/** Escalation counts bucketed by day, for the trend line. */
export function volumeByDay(days = 30) {
  return getDb()
    .prepare(
      `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count
       FROM tickets WHERE created_at >= ?
       GROUP BY day ORDER BY day ASC`,
    )
    .all(daysAgoIso(days));
}

export function volumeSummary() {
  const db = getDb();
  const count = (since) =>
    db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE created_at >= ?').get(since).n;
  return {
    today: count(daysAgoIso(0)),
    last_7_days: count(daysAgoIso(7)),
    last_30_days: count(daysAgoIso(30)),
    all_time: db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n,
  };
}

export function statusBreakdown() {
  const rows = getDb()
    .prepare('SELECT status, COUNT(*) AS count FROM tickets GROUP BY status')
    .all();
  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}

export function severityBreakdown(days = 30) {
  return getDb()
    .prepare(
      `SELECT severity, COUNT(*) AS count FROM tickets
       WHERE created_at >= ? GROUP BY severity ORDER BY severity ASC`,
    )
    .all(daysAgoIso(days));
}

/**
 * Response and resolution performance over a window.
 * sla_compliance is the number that tells you whether support is actually fast:
 * the share of escalations answered inside their severity's promised window.
 */
export function responseMetrics(days = 30) {
  const db = getDb();
  const since = daysAgoIso(days);

  const responded = db
    .prepare(
      `SELECT created_at, first_responded_at, first_response_due_at
       FROM tickets WHERE created_at >= ? AND first_responded_at IS NOT NULL`,
    )
    .all(since);

  const resolved = db
    .prepare(
      `SELECT created_at, resolved_at FROM tickets
       WHERE created_at >= ? AND resolved_at IS NOT NULL`,
    )
    .all(since);

  const responseHours = responded.map(
    (t) => (new Date(t.first_responded_at) - new Date(t.created_at)) / 3600_000,
  );
  const resolutionHours = resolved.map(
    (t) => (new Date(t.resolved_at) - new Date(t.created_at)) / 3600_000,
  );
  const withinSla = responded.filter(
    (t) => new Date(t.first_responded_at) <= new Date(t.first_response_due_at),
  ).length;

  const totalInWindow = db
    .prepare('SELECT COUNT(*) AS n FROM tickets WHERE created_at >= ?')
    .get(since).n;
  const reopened = db
    .prepare('SELECT COUNT(*) AS n FROM tickets WHERE created_at >= ? AND reopened_count > 0')
    .get(since).n;

  return {
    window_days: days,
    responded_count: responded.length,
    avg_first_response_hours: round(
      responseHours.length ? responseHours.reduce((a, b) => a + b, 0) / responseHours.length : null,
    ),
    median_first_response_hours: round(median(responseHours)),
    sla_compliance_pct: responded.length ? round((withinSla / responded.length) * 100) : null,
    resolved_count: resolved.length,
    avg_resolution_hours: round(
      resolutionHours.length
        ? resolutionHours.reduce((a, b) => a + b, 0) / resolutionHours.length
        : null,
    ),
    median_resolution_hours: round(median(resolutionHours)),
    reopen_rate_pct: totalInWindow ? round((reopened / totalInWindow) * 100) : null,
  };
}

/** Open tickets past their first-response SLA, worst first. */
export function breachedTickets() {
  return getDb()
    .prepare(
      `SELECT t.id, t.ticket_number, t.subject, t.severity, t.status,
              t.first_response_due_at, c.name AS customer_name, c.company AS customer_company
       FROM tickets t JOIN customers c ON c.id = t.customer_id
       WHERE t.first_responded_at IS NULL
         AND t.status NOT IN ('resolved','closed')
         AND t.first_response_due_at < ?
       ORDER BY t.first_response_due_at ASC`,
    )
    .all(nowIso());
}

/**
 * Recurring themes with a direction of travel: this window vs the one before it.
 * A theme that is up sharply is where the next process fix belongs.
 */
export function themeTrends(days = 30, limit = 15) {
  const db = getDb();
  const since = daysAgoIso(days);
  const prevSince = daysAgoIso(days * 2);

  const current = db
    .prepare(
      `SELECT a.theme, COUNT(*) AS count,
              SUM(CASE WHEN a.preventable = 1 THEN 1 ELSE 0 END) AS preventable_count,
              ROUND(AVG(a.urgency_score), 1) AS avg_urgency
       FROM ticket_analysis a JOIN tickets t ON t.id = a.ticket_id
       WHERE t.created_at >= ?
       GROUP BY a.theme ORDER BY count DESC LIMIT ?`,
    )
    .all(since, limit);

  const previous = Object.fromEntries(
    db
      .prepare(
        `SELECT a.theme, COUNT(*) AS count
         FROM ticket_analysis a JOIN tickets t ON t.id = a.ticket_id
         WHERE t.created_at >= ? AND t.created_at < ?
         GROUP BY a.theme`,
      )
      .all(prevSince, since)
      .map((r) => [r.theme, r.count]),
  );

  return current.map((row) => {
    const prev = previous[row.theme] ?? 0;
    return {
      ...row,
      previous_count: prev,
      change: row.count - prev,
      direction: row.count > prev ? 'up' : row.count < prev ? 'down' : 'flat',
    };
  });
}

export function rootCauseBreakdown(days = 30) {
  return getDb()
    .prepare(
      `SELECT a.root_cause_category AS category, COUNT(*) AS count
       FROM ticket_analysis a JOIN tickets t ON t.id = a.ticket_id
       WHERE t.created_at >= ?
       GROUP BY category ORDER BY count DESC`,
    )
    .all(daysAgoIso(days));
}

/**
 * Customers ranked by escalation load. `negative_count` is the tell: a customer
 * with many tickets and mostly negative sentiment is an account at risk, not a
 * heavy user.
 */
export function topCustomers(days = 90, limit = 15) {
  return getDb()
    .prepare(
      `SELECT c.id, c.name, c.company, c.email,
              COUNT(t.id) AS ticket_count,
              SUM(CASE WHEN a.sentiment IN ('frustrated','angry') THEN 1 ELSE 0 END) AS negative_count,
              SUM(CASE WHEN t.severity IN ('P1','P2') THEN 1 ELSE 0 END) AS high_severity_count,
              SUM(CASE WHEN t.reopened_count > 0 THEN 1 ELSE 0 END) AS reopened_count,
              MAX(t.created_at) AS last_ticket_at
       FROM customers c
       JOIN tickets t ON t.customer_id = c.id
       LEFT JOIN ticket_analysis a ON a.ticket_id = t.id
       WHERE t.created_at >= ?
       GROUP BY c.id
       HAVING ticket_count > 0
       ORDER BY ticket_count DESC, negative_count DESC
       LIMIT ?`,
    )
    .all(daysAgoIso(days), limit);
}

/** How much of our volume was avoidable - the size of the improvement prize. */
export function preventableShare(days = 30) {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN a.preventable = 1 THEN 1 ELSE 0 END) AS preventable
       FROM ticket_analysis a JOIN tickets t ON t.id = a.ticket_id
       WHERE t.created_at >= ?`,
    )
    .get(daysAgoIso(days));
  return {
    analyzed: row.total,
    preventable: row.preventable ?? 0,
    preventable_pct: row.total ? round(((row.preventable ?? 0) / row.total) * 100) : null,
  };
}

export function snapshot({ days = 30 } = {}) {
  return {
    generated_at: nowIso(),
    volume: volumeSummary(),
    volume_by_day: volumeByDay(days),
    status: statusBreakdown(),
    severity: severityBreakdown(days),
    performance: responseMetrics(days),
    breached: breachedTickets(),
    themes: themeTrends(days),
    root_causes: rootCauseBreakdown(days),
    top_customers: topCustomers(90),
    preventable: preventableShare(days),
  };
}
