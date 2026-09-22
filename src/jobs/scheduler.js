/**
 * In-process schedulers. Started from the server when RUN_JOBS=1, so a small
 * deployment needs no separate cron. On a platform that already gives you cron,
 * leave RUN_JOBS off and call the scripts instead.
 */
import { getDb } from '../db/index.js';
import { breachedTickets } from '../core/kpi.js';
import { generateDigest } from '../ai/digest.js';
import { getTicket, setStatus, addEvent } from '../core/tickets.js';
import { notifyCustomer, syncStatusToGhl } from '../ghl/sync.js';
import { nowIso } from '../core/time.js';

const HOUR = 3600_000;

/** Logs SLA breaches once each, so the dashboard banner has a paper trail. */
export async function checkBreaches() {
  const db = getDb();
  for (const t of breachedTickets()) {
    const already = db
      .prepare("SELECT 1 FROM ticket_events WHERE ticket_id = ? AND type = 'sla_breach'")
      .get(t.id);
    if (already) continue;
    addEvent(t.id, 'sla_breach', {
      note: `No first response by ${t.first_response_due_at} (${t.severity})`,
    });
    console.warn(`[sla] BREACH ${t.ticket_number} (${t.severity}) — ${t.subject}`);
  }
}

/**
 * Auto-closes tickets the customer has gone quiet on (7 days in Pending
 * Customer) and resolved tickets after 5 days. Both leave an event behind, and
 * either can be reopened simply by moving the ticket back.
 */
export async function autoAdvance() {
  const db = getDb();
  const stale = db
    .prepare(
      `SELECT id, status FROM tickets
       WHERE (status = 'pending_customer' AND updated_at < datetime('now','-7 days'))
          OR (status = 'resolved'         AND updated_at < datetime('now','-5 days'))`,
    )
    .all();

  for (const row of stale) {
    const reason =
      row.status === 'pending_customer'
        ? 'Auto-closed: no customer reply for 7 days'
        : 'Auto-closed: resolved 5 days ago with no reopen';
    setStatus(row.id, 'closed', { actor: 'scheduler', note: reason });
    try {
      await syncStatusToGhl(getTicket(row.id));
    } catch (err) {
      console.error(`[jobs] close sync failed: ${err.message}`);
    }
  }
}

/** Nudges customers we are waiting on, once, after 48 hours of silence. */
export async function nudgePendingCustomers() {
  const db = getDb();
  const waiting = db
    .prepare(
      `SELECT t.id FROM tickets t
       WHERE t.status = 'pending_customer'
         AND t.updated_at < datetime('now','-2 days')
         AND NOT EXISTS (
           SELECT 1 FROM ticket_events e
           WHERE e.ticket_id = t.id AND e.type = 'customer_nudged')`,
    )
    .all();

  for (const row of waiting) {
    const ticket = getTicket(row.id);
    try {
      await notifyCustomer(ticket, 'pending_customer');
      addEvent(ticket.id, 'customer_nudged', { note: '48h reminder' });
    } catch (err) {
      console.error(`[jobs] nudge failed for ${ticket.ticket_number}: ${err.message}`);
    }
  }
}

export function startSchedulers() {
  const run = async (name, fn) => {
    try {
      await fn();
    } catch (err) {
      console.error(`[jobs] ${name} failed: ${err.message}`);
    }
  };

  setInterval(() => run('breaches', checkBreaches), 15 * 60_000).unref();
  setInterval(() => run('auto-advance', autoAdvance), 6 * HOUR).unref();
  setInterval(() => run('nudge', nudgePendingCustomers), 6 * HOUR).unref();

  // Daily review at ~07:00 UTC; weekly on Monday; monthly on the 1st.
  setInterval(() => {
    const now = new Date();
    if (now.getUTCHours() !== 7) return;
    run('daily digest', () => generateDigest('daily'));
    if (now.getUTCDay() === 1) run('weekly digest', () => generateDigest('weekly'));
    if (now.getUTCDate() === 1) run('monthly digest', () => generateDigest('monthly'));
  }, HOUR).unref();

  console.log(`[jobs] schedulers started at ${nowIso()}`);
}
