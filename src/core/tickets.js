import { getDb, transaction } from '../db/index.js';
import { nowIso, toIso } from './time.js';
import { normalizeSeverity, firstResponseDueAt } from './sla.js';

export const STATUSES = [
  'new',
  'active',
  'pending_customer',
  'pending_internal',
  'resolved',
  'closed',
];

export const STATUS_LABELS = {
  new: 'New Escalation',
  active: 'Active',
  pending_customer: 'Pending Customer',
  pending_internal: 'Pending Internal',
  resolved: 'Resolved',
  closed: 'Closed',
};

/** Statuses where the clock is on us, not the customer. */
export const OPEN_STATUSES = ['new', 'active', 'pending_internal'];

export function isOpen(status) {
  return !['resolved', 'closed'].includes(status);
}

function nextTicketNumber(db) {
  const row = db.prepare('SELECT COUNT(*) AS n FROM tickets').get();
  return `TKT-${String(row.n + 1).padStart(5, '0')}`;
}

/**
 * Finds an existing customer by GHL contact id, then email, then phone.
 * Escalations arrive from a public form, so the same human shows up with
 * inconsistent details - matching on all three keeps their history together.
 */
export function upsertCustomer({ ghlContactId, email, phone, name, company }) {
  const db = getDb();
  const normEmail = email ? email.trim().toLowerCase() : null;
  const normPhone = phone ? phone.replace(/[^\d+]/g, '') : null;

  let existing = null;
  if (ghlContactId) {
    existing = db.prepare('SELECT * FROM customers WHERE ghl_contact_id = ?').get(ghlContactId);
  }
  if (!existing && normEmail) {
    existing = db.prepare('SELECT * FROM customers WHERE email = ?').get(normEmail);
  }
  if (!existing && normPhone) {
    existing = db.prepare('SELECT * FROM customers WHERE phone = ?').get(normPhone);
  }

  if (existing) {
    db.prepare(
      `UPDATE customers SET
         ghl_contact_id = COALESCE(?, ghl_contact_id),
         email          = COALESCE(?, email),
         phone          = COALESCE(?, phone),
         name           = COALESCE(?, name),
         company        = COALESCE(?, company),
         updated_at     = ?
       WHERE id = ?`,
    ).run(ghlContactId ?? null, normEmail, normPhone, name ?? null, company ?? null, nowIso(), existing.id);
    return db.prepare('SELECT * FROM customers WHERE id = ?').get(existing.id);
  }

  const info = db
    .prepare(
      `INSERT INTO customers (ghl_contact_id, email, phone, name, company)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(ghlContactId ?? null, normEmail, normPhone, name ?? null, company ?? null);
  return db.prepare('SELECT * FROM customers WHERE id = ?').get(info.lastInsertRowid);
}

export function createTicket(input) {
  const severity = normalizeSeverity(input.severity);
  const createdAt = nowIso();

  return transaction((db) => {
    const customer = upsertCustomer({
      ghlContactId: input.ghlContactId,
      email: input.customerEmail,
      phone: input.customerPhone,
      name: input.customerName,
      company: input.customerCompany,
    });

    const ticketNumber = nextTicketNumber(db);
    const info = db
      .prepare(
        `INSERT INTO tickets (
           ticket_number, customer_id, status, severity, category, subject, description,
           steps_taken, customer_impact, escalated_by, source, first_response_due_at,
           created_at, updated_at
         ) VALUES (?, ?, 'new', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ticketNumber,
        customer.id,
        severity,
        input.category ?? null,
        input.subject,
        input.description,
        input.stepsTaken ?? null,
        input.customerImpact ?? null,
        input.escalatedBy ?? null,
        input.source ?? 'form',
        toIso(firstResponseDueAt(severity, new Date(createdAt))),
        createdAt,
        createdAt,
      );

    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO ticket_events (ticket_id, type, to_status, actor, note)
       VALUES (?, 'created', 'new', ?, ?)`,
    ).run(ticket.id, input.escalatedBy ?? 'system', `Escalation received via ${input.source ?? 'form'}`);

    return { ticket, customer };
  });
}

/**
 * Moves a ticket to a new status and stamps the derived timestamps.
 * Returns null if the ticket does not exist, or the unchanged ticket if the
 * status is already what was asked for (so webhook replays are harmless).
 */
export function setStatus(ticketId, status, { actor, note } = {}) {
  if (!STATUSES.includes(status)) {
    throw new Error(`Unknown status "${status}". Valid: ${STATUSES.join(', ')}`);
  }

  return transaction((db) => {
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
    if (!ticket) return null;
    if (ticket.status === status) return ticket;

    const now = nowIso();
    const fields = { status, updated_at: now };

    // First response = the first time a human moved it off "new".
    if (ticket.status === 'new' && !ticket.first_responded_at) {
      fields.first_responded_at = now;
    }
    if (status === 'resolved') fields.resolved_at = now;
    if (status === 'closed') fields.closed_at = now;
    if (['resolved', 'closed'].includes(ticket.status) && isOpen(status)) {
      fields.reopened_count = ticket.reopened_count + 1;
      fields.resolved_at = null;
      fields.closed_at = null;
    }

    const setSql = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE tickets SET ${setSql} WHERE id = ?`).run(...Object.values(fields), ticketId);

    db.prepare(
      `INSERT INTO ticket_events (ticket_id, type, from_status, to_status, actor, note)
       VALUES (?, 'status_change', ?, ?, ?, ?)`,
    ).run(ticketId, ticket.status, status, actor ?? 'system', note ?? null);

    return db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  });
}

export function updateTicket(ticketId, patch) {
  const allowed = [
    'severity', 'category', 'assigned_to', 'resolution_summary',
    'ghl_opportunity_id', 'subject', 'description',
  ];
  const fields = {};
  for (const [k, v] of Object.entries(patch)) {
    if (allowed.includes(k) && v !== undefined) fields[k] = v;
  }
  if (!Object.keys(fields).length) return getTicket(ticketId);

  const db = getDb();
  fields.updated_at = nowIso();
  const setSql = Object.keys(fields).map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE tickets SET ${setSql} WHERE id = ?`).run(...Object.values(fields), ticketId);
  return getTicket(ticketId);
}

export function addEvent(ticketId, type, { actor, note } = {}) {
  getDb()
    .prepare('INSERT INTO ticket_events (ticket_id, type, actor, note) VALUES (?, ?, ?, ?)')
    .run(ticketId, type, actor ?? 'system', note ?? null);
}

export function getTicket(idOrNumber) {
  const db = getDb();
  const col = typeof idOrNumber === 'number' ? 'id' : 'ticket_number';
  return db
    .prepare(
      `SELECT t.*, c.name AS customer_name, c.email AS customer_email,
              c.phone AS customer_phone, c.company AS customer_company,
              c.ghl_contact_id AS ghl_contact_id
       FROM tickets t JOIN customers c ON c.id = t.customer_id
       WHERE t.${col} = ?`,
    )
    .get(idOrNumber);
}

export function getTicketEvents(ticketId) {
  return getDb()
    .prepare('SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id ASC')
    .all(ticketId);
}

export function listTickets({ status, severity, limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = [];
  if (status) {
    where.push(`t.status IN (${status.split(',').map(() => '?').join(',')})`);
    params.push(...status.split(','));
  }
  if (severity) {
    where.push('t.severity = ?');
    params.push(severity);
  }
  const sql = `
    SELECT t.*, c.name AS customer_name, c.email AS customer_email, c.company AS customer_company,
           a.theme AS theme, a.sentiment AS sentiment
    FROM tickets t
    JOIN customers c ON c.id = t.customer_id
    LEFT JOIN ticket_analysis a ON a.ticket_id = t.id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY t.created_at DESC
    LIMIT ? OFFSET ?`;
  return getDb().prepare(sql).all(...params, limit, offset);
}
