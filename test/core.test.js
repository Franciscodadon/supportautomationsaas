import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDb = path.join(os.tmpdir(), `support-test-${Date.now()}.db`);
process.env.DATABASE_PATH = tmpDb;
process.env.AI_ENABLED = '0';
process.env.DOTENV_PATH = '/nonexistent';

const { createTicket, setStatus, getTicket, listTickets, getTicketEvents, updateTicket } =
  await import('../src/core/tickets.js');
const { normalizeIntake, IntakeError } = await import('../src/core/intake.js');
const { normalizeSeverity, firstResponseDueAt, isBreached, SLA_HOURS } =
  await import('../src/core/sla.js');
const { responseMetrics, statusBreakdown, topCustomers, breachedTickets } =
  await import('../src/core/kpi.js');
const { closeDb } = await import('../src/db/index.js');

after(() => {
  closeDb();
  for (const f of [tmpDb, `${tmpDb}-wal`, `${tmpDb}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

const base = {
  customerName: 'Dana Whitfield',
  customerEmail: 'dana@northgate.io',
  customerCompany: 'Northgate Logistics',
  subject: 'SSO login loop',
  description: 'Cannot sign in via Google SSO.',
  escalatedBy: 'jordan.l1',
};

test('severity normalization accepts the spellings a form will actually produce', () => {
  assert.equal(normalizeSeverity('P1'), 'P1');
  assert.equal(normalizeSeverity('p2'), 'P2');
  assert.equal(normalizeSeverity('Critical - service down'), 'P1');
  assert.equal(normalizeSeverity('High'), 'P2');
  assert.equal(normalizeSeverity('just a question'), 'P4');
  assert.equal(normalizeSeverity(undefined), 'P3');
  assert.equal(normalizeSeverity('gibberish'), 'P3');
});

test('SLA due time follows the severity table', () => {
  const at = new Date('2026-01-01T00:00:00Z');
  for (const [sev, hours] of Object.entries(SLA_HOURS)) {
    const due = firstResponseDueAt(sev, at);
    assert.equal((due - at) / 3600_000, hours, `${sev} should be ${hours}h`);
  }
});

test('intake accepts alternative field names and nested customData', () => {
  const intake = normalizeIntake({
    full_name: 'Marcus Reyes',
    email: 'marcus@bellcurve.co',
    customData: { issue_subject: 'Double charge', details: 'Charged twice', urgency: 'High' },
  });
  assert.equal(intake.customerName, 'Marcus Reyes');
  assert.equal(intake.subject, 'Double charge');
  assert.equal(intake.description, 'Charged twice');
  assert.equal(intake.severity, 'P2');
});

test('intake rejects a payload with no way to identify the customer', () => {
  assert.throws(
    () => normalizeIntake({ subject: 'Broken', description: 'It is broken' }),
    (err) => err instanceof IntakeError && err.fields.includes('customer_email or customer_phone'),
  );
});

test('a ticket is created with a number, a due time and a created event', () => {
  const { ticket, customer } = createTicket(base);
  assert.match(ticket.ticket_number, /^TKT-\d{5}$/);
  assert.equal(ticket.status, 'new');
  assert.equal(ticket.severity, 'P3');
  assert.ok(ticket.first_response_due_at);
  assert.equal(customer.email, 'dana@northgate.io');

  const events = getTicketEvents(ticket.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'created');
});

test('the same customer under a different name reuses one record', () => {
  const a = createTicket({ ...base, subject: 'First' });
  const b = createTicket({ ...base, customerName: 'D. Whitfield', subject: 'Second' });
  assert.equal(a.customer.id, b.customer.id);
});

test('moving off new stamps the first response exactly once', () => {
  const { ticket } = createTicket({ ...base, subject: 'Response timing' });
  assert.equal(ticket.first_responded_at, null);

  const active = setStatus(ticket.id, 'active', { actor: 'sam' });
  assert.equal(active.status, 'active');
  assert.ok(active.first_responded_at);

  const pending = setStatus(ticket.id, 'pending_customer', { actor: 'sam' });
  assert.equal(pending.first_responded_at, active.first_responded_at,
    'first response must not be re-stamped on later transitions');
});

test('re-sending the same status is a no-op, so webhook replays are safe', () => {
  const { ticket } = createTicket({ ...base, subject: 'Replay' });
  setStatus(ticket.id, 'active');
  const before = getTicketEvents(ticket.id).length;
  setStatus(ticket.id, 'active');
  assert.equal(getTicketEvents(ticket.id).length, before);
});

test('reopening a resolved ticket clears the resolution stamps and counts it', () => {
  const { ticket } = createTicket({ ...base, subject: 'Reopen me' });
  setStatus(ticket.id, 'active');
  setStatus(ticket.id, 'resolved');
  assert.ok(getTicket(ticket.id).resolved_at);

  const reopened = setStatus(ticket.id, 'active', { note: 'customer says still broken' });
  assert.equal(reopened.resolved_at, null);
  assert.equal(reopened.reopened_count, 1);
});

test('an unknown status is rejected rather than silently stored', () => {
  const { ticket } = createTicket({ ...base, subject: 'Bad status' });
  assert.throws(() => setStatus(ticket.id, 'nonsense'), /Unknown status/);
});

test('a P1 with no response shows up as breached once its window passes', () => {
  const { ticket } = createTicket({ ...base, subject: 'Breach me', severity: 'P1' });
  const past = new Date(Date.now() - 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  assert.ok(isBreached({ ...getTicket(ticket.id), first_response_due_at: past }));

  // Answering it stops the clock for good.
  assert.equal(
    isBreached({ ...getTicket(ticket.id), first_response_due_at: past, first_responded_at: past }),
    false,
  );
});

test('kpi aggregates read back what the ticket layer wrote', () => {
  const counts = statusBreakdown();
  assert.ok(counts.new >= 1, 'expected at least one new ticket');

  const metrics = responseMetrics(365);
  assert.ok(metrics.responded_count >= 1);
  assert.ok(metrics.median_first_response_hours !== null);
  assert.ok(metrics.sla_compliance_pct >= 0 && metrics.sla_compliance_pct <= 100);

  const customers = topCustomers(365);
  assert.ok(customers.length >= 1);
  assert.equal(customers[0].company, 'Northgate Logistics');

  assert.ok(Array.isArray(breachedTickets()));
});

test('listTickets filters by status', () => {
  const open = listTickets({ status: 'new' });
  assert.ok(open.every((t) => t.status === 'new'));
});
