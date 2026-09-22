import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getDb } from './db/index.js';
import { normalizeIntake, IntakeError } from './core/intake.js';
import {
  createTicket, setStatus, updateTicket, getTicket, getTicketEvents,
  listTickets, STATUSES, STATUS_LABELS,
} from './core/tickets.js';
import { snapshot } from './core/kpi.js';
import { syncTicketToGhl, syncStatusToGhl, notifyCustomer, alertInternal } from './ghl/sync.js';
import { classifyTicket, getAnalysis, knownThemes } from './ai/classify.js';
import { generateDigest, latestDigest } from './ai/digest.js';
import { startSchedulers } from './jobs/scheduler.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

getDb();

// ------------------------------------------------------------------- auth

/** Constant-time-ish comparison so the secret can't be probed by timing. */
function secretMatches(provided, expected) {
  if (!expected || !provided || provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function requireWebhookSecret(req, res, next) {
  const provided = req.get('X-Webhook-Secret') || req.query.token || req.body?.token;
  if (!secretMatches(provided, config.webhookSecret)) {
    return res.status(401).json({ error: 'Invalid or missing webhook secret' });
  }
  next();
}

function requireDashboardAuth(req, res, next) {
  const header = req.get('Authorization') || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
    if (user === config.dashboard.user && secretMatches(pass, config.dashboard.password)) {
      return next();
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="Support Dashboard"');
  res.status(401).send('Authentication required');
}

// -------------------------------------------------------------- intake

/**
 * The escalation entry point. Point the GHL form's workflow webhook here, or
 * POST directly from any L1 tool.
 *
 * Responds as soon as the ticket is durable; the GHL push and AI analysis run
 * after the response so a slow third party can never cause the form to retry
 * and duplicate the escalation.
 */
app.post('/webhook/escalation', requireWebhookSecret, async (req, res) => {
  let intake;
  try {
    intake = normalizeIntake(req.body, { source: req.query.source || 'form' });
  } catch (err) {
    if (err instanceof IntakeError) {
      return res.status(400).json({ error: err.message, missing: err.fields });
    }
    throw err;
  }

  const { ticket } = createTicket(intake);
  res.status(201).json({
    ok: true,
    ticket_number: ticket.ticket_number,
    status: ticket.status,
    severity: ticket.severity,
    first_response_due_at: ticket.first_response_due_at,
  });

  queueMicrotask(async () => {
    try {
      await syncTicketToGhl(getTicket(ticket.id));
      const synced = getTicket(ticket.id);
      await alertInternal(synced);
      await notifyCustomer(synced, 'acknowledged');
    } catch (err) {
      console.error(`[intake] GHL sync failed for ${ticket.ticket_number}: ${err.message}`);
    }
    try {
      await classifyTicket(getTicket(ticket.id));
    } catch (err) {
      console.error(`[intake] AI analysis failed for ${ticket.ticket_number}: ${err.message}`);
    }
  });
});

/**
 * Status changes coming back from GHL. Wire this to a workflow on each
 * pipeline stage so dragging a card in GHL updates the ticket and emails
 * the customer. Body: { ticket_number, status, actor?, note?, resolution_summary? }
 */
app.post('/webhook/status', requireWebhookSecret, async (req, res) => {
  const { ticket_number: ticketNumber, status, actor, note, resolution_summary: resolution } = req.body ?? {};
  if (!ticketNumber || !status) {
    return res.status(400).json({ error: 'ticket_number and status are required' });
  }
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }

  const existing = getTicket(ticketNumber);
  if (!existing) return res.status(404).json({ error: `Unknown ticket ${ticketNumber}` });

  if (resolution) updateTicket(existing.id, { resolution_summary: resolution });
  const updated = setStatus(existing.id, status, { actor, note });
  const full = getTicket(updated.id);

  res.json({ ok: true, ticket_number: full.ticket_number, status: full.status });

  queueMicrotask(async () => {
    try {
      await syncStatusToGhl(full);
      const template = { pending_customer: 'pending_customer', pending_internal: 'pending_internal', resolved: 'resolved' }[status];
      if (template) await notifyCustomer(full, template);
    } catch (err) {
      console.error(`[status] sync failed for ${full.ticket_number}: ${err.message}`);
    }
  });
});

// ----------------------------------------------------------------- API

app.get('/api/tickets', requireDashboardAuth, (req, res) => {
  res.json(
    listTickets({
      status: req.query.status,
      severity: req.query.severity,
      limit: Math.min(Number(req.query.limit) || 50, 200),
      offset: Number(req.query.offset) || 0,
    }),
  );
});

app.get('/api/tickets/:number', requireDashboardAuth, (req, res) => {
  const ticket = getTicket(req.params.number);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  res.json({ ticket, events: getTicketEvents(ticket.id), analysis: getAnalysis(ticket.id) });
});

app.post('/api/tickets/:number/status', requireDashboardAuth, async (req, res) => {
  const ticket = getTicket(req.params.number);
  if (!ticket) return res.status(404).json({ error: 'Not found' });
  const { status, note, resolution_summary: resolution } = req.body ?? {};
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  if (resolution) updateTicket(ticket.id, { resolution_summary: resolution });
  setStatus(ticket.id, status, { actor: 'dashboard', note });
  const full = getTicket(ticket.id);
  res.json({ ok: true, status: full.status });

  queueMicrotask(async () => {
    try {
      await syncStatusToGhl(full);
      const template = { pending_customer: 'pending_customer', pending_internal: 'pending_internal', resolved: 'resolved' }[status];
      if (template) await notifyCustomer(full, template);
    } catch (err) {
      console.error(`[dashboard] sync failed for ${full.ticket_number}: ${err.message}`);
    }
  });
});

app.get('/api/kpi', requireDashboardAuth, (req, res) => {
  res.json(snapshot({ days: Math.min(Number(req.query.days) || 30, 365) }));
});

app.get('/api/themes', requireDashboardAuth, (req, res) => res.json(knownThemes(200)));

app.get('/api/digest/:period', requireDashboardAuth, (req, res) => {
  const digest = latestDigest(req.params.period);
  if (!digest) return res.status(404).json({ error: 'No digest generated yet' });
  res.json(digest);
});

app.post('/api/digest/:period', requireDashboardAuth, async (req, res) => {
  try {
    res.json(await generateDigest(req.params.period));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/meta', requireDashboardAuth, (req, res) => {
  res.json({ statuses: STATUSES, status_labels: STATUS_LABELS, ai_enabled: config.ai.enabled });
});

// ----------------------------------------------------------- dashboard

app.get('/healthz', (req, res) => res.json({ ok: true, ai: config.ai.enabled }));
app.get('/', (req, res) => res.redirect('/dashboard'));
app.get('/dashboard', requireDashboardAuth, (req, res) =>
  res.sendFile(path.join(here, 'dashboard', 'index.html')),
);

app.use((err, req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: 'Internal error' });
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(config.port, () => {
    console.log(`Support automation listening on :${config.port}`);
    console.log(`  Escalation intake : POST /webhook/escalation`);
    console.log(`  Status updates    : POST /webhook/status`);
    console.log(`  Dashboard         : GET  /dashboard`);
    if (!config.webhookSecret) console.warn('  ! WEBHOOK_SECRET is empty - intake is unprotected.');
    if (!config.ghl.apiKey) console.warn('  ! GHL_API_KEY is empty - tickets will not reach GoHighLevel.');
    if (!config.ai.enabled) console.warn('  ! AI analysis disabled - no themes or digests will be produced.');
  });
  if (process.env.RUN_JOBS === '1') startSchedulers();
}

export { app };
