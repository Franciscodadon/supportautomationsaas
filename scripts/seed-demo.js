#!/usr/bin/env node
/**
 * Loads realistic demo escalations so the dashboard has something to show
 * before real traffic arrives. Writes only to the local database - it never
 * touches GoHighLevel and never emails anyone.
 *
 * Usage: npm run seed
 */
import { createTicket, setStatus, updateTicket } from '../src/core/tickets.js';
import { getDb } from '../src/db/index.js';

const ACCOUNTS = [
  { name: 'Dana Whitfield', email: 'dana@northgate.io',   company: 'Northgate Logistics' },
  { name: 'Marcus Reyes',   email: 'marcus@bellcurve.co', company: 'Bell Curve Media' },
  { name: 'Priya Raman',    email: 'priya@arcadia.dev',   company: 'Arcadia Studio' },
  { name: 'Tom Okafor',     email: 'tom@harbourpoint.com', company: 'Harbour Point Dental' },
];

const ISSUES = [
  { subject: 'SSO login loops back to the sign-in page', severity: 'P1', category: 'Authentication',
    description: 'Customer cannot log in via Google SSO. After choosing the account the browser returns to the sign-in page with no error shown. Affects all 14 seats.', },
  { subject: 'Monthly invoice charged twice', severity: 'P2', category: 'Billing',
    description: 'Two identical charges for the March invoice, three minutes apart. Customer wants one refunded and an explanation.', },
  { subject: 'CSV export truncates at 1,000 rows', severity: 'P3', category: 'Reporting',
    description: 'Exporting the contacts report silently stops at 1,000 rows with no warning to the user.', },
  { subject: 'Webhook deliveries stopped overnight', severity: 'P1', category: 'Integrations',
    description: 'No webhook deliveries received since 23:40 last night. The endpoint is up and returning 200 to manual tests.', },
  { subject: 'How do I bulk-reassign contacts to a new owner?', severity: 'P4', category: 'How-to',
    description: 'Customer has 2,300 contacts assigned to a staff member who left and wants them moved in one action.', },
  { subject: 'SSO login loops after password reset', severity: 'P2', category: 'Authentication',
    description: 'Same redirect loop as reported by other accounts, this time triggered right after a password reset.', },
  { subject: 'Calendar invites arriving in the wrong timezone', severity: 'P3', category: 'Calendar',
    description: 'Bookings confirmed at 2pm arrive in the customer invite as 9am. Account timezone is set correctly.', },
  { subject: 'Report page takes 40+ seconds to load', severity: 'P3', category: 'Performance',
    description: 'The analytics dashboard takes 40-60 seconds to render for this account, and sometimes times out.', },
];

const agents = ['jordan.l1', 'sam.l1', 'alex.l1'];
const pick = (a) => a[Math.floor(Math.random() * a.length)];

console.log('Seeding demo escalations…');
const db = getDb();
let created = 0;

for (let i = 0; i < 24; i++) {
  const issue = ISSUES[i % ISSUES.length];
  const account = ACCOUNTS[i % ACCOUNTS.length];
  const daysAgo = Math.floor(Math.random() * 28);

  const { ticket } = createTicket({
    customerName: account.name,
    customerEmail: account.email,
    customerCompany: account.company,
    subject: issue.subject,
    description: issue.description,
    severity: issue.severity,
    category: issue.category,
    source: 'seed',
  });

  // Backdate so the volume chart has shape.
  const createdAt = new Date(Date.now() - daysAgo * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  db.prepare('UPDATE tickets SET created_at = ?, updated_at = ? WHERE id = ?')
    .run(createdAt, createdAt, ticket.id);

  const roll = Math.random();
  if (roll > 0.35) {
    setStatus(ticket.id, 'active', { actor: pick(agents) });
    const respondedAt = new Date(new Date(createdAt).getTime() + Math.random() * 10 * 3600_000)
      .toISOString().replace(/\.\d{3}Z$/, 'Z');
    db.prepare('UPDATE tickets SET first_responded_at = ? WHERE id = ?').run(respondedAt, ticket.id);
  }
  if (roll > 0.75) {
    updateTicket(ticket.id, { resolution_summary: 'Root cause identified and corrected; customer confirmed.' });
    setStatus(ticket.id, 'resolved', { actor: 'senior.support' });
    const resolvedAt = new Date(new Date(createdAt).getTime() + (4 + Math.random() * 60) * 3600_000)
      .toISOString().replace(/\.\d{3}Z$/, 'Z');
    db.prepare('UPDATE tickets SET resolved_at = ? WHERE id = ?').run(resolvedAt, ticket.id);
  } else if (roll > 0.6) {
    setStatus(ticket.id, 'pending_customer', { actor: pick(agents) });
  }
  created++;
}

console.log(`Seeded ${created} escalations across ${ACCOUNTS.length} accounts.`);
console.log('Run `npm start` and open http://localhost:3000/dashboard');
console.log('Themes and the AI review stay empty until you run analysis with an ANTHROPIC_API_KEY set.');
