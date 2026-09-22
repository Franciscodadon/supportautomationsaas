import { config } from '../config.js';
import { upsertContact, createOpportunity, updateOpportunity, sendEmail, sendSms } from './client.js';
import { STATUS_FIELD_VALUES } from './fields.js';
import { STATUS_LABELS } from '../core/tickets.js';
import { updateTicket, addEvent } from '../core/tickets.js';
import { getDb } from '../db/index.js';

const splitName = (full) => {
  const parts = (full || '').trim().split(/\s+/);
  return { firstName: parts[0] || 'Unknown', lastName: parts.slice(1).join(' ') || '' };
};

function ticketCustomFields(ticket) {
  const pairs = {
    support_ticket_id: ticket.ticket_number,
    support_status: STATUS_FIELD_VALUES[ticket.status],
    support_severity: ticket.severity,
    support_category: ticket.category,
    support_subject: ticket.subject,
    support_summary: ticket.description,
    support_steps_taken: ticket.steps_taken,
    support_impact: ticket.customer_impact,
    support_escalated_by: ticket.escalated_by,
    support_due_at: ticket.first_response_due_at,
    support_resolution: ticket.resolution_summary,
  };
  return Object.entries(pairs)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([key, field_value]) => ({ key, field_value }));
}

/**
 * Pushes a ticket into GHL: upserts the CUSTOMER's contact (not the escalating
 * agent's), stamps the ticket fields onto it, and opens an opportunity in the
 * support pipeline. Safe to call repeatedly - the opportunity is only created once.
 */
export async function syncTicketToGhl(ticket) {
  const { firstName, lastName } = splitName(ticket.customer_name);

  const contactResult = await upsertContact({
    email: ticket.customer_email,
    phone: ticket.customer_phone,
    firstName,
    lastName,
    companyName: ticket.customer_company,
    tags: ['support-escalation', `severity-${ticket.severity.toLowerCase()}`],
    customFields: ticketCustomFields(ticket),
  });

  const contactId = contactResult?.contact?.id ?? contactResult?.id;
  if (!contactId) {
    throw new Error(`GHL upsert returned no contact id for ${ticket.ticket_number}`);
  }

  getDb()
    .prepare('UPDATE customers SET ghl_contact_id = ? WHERE id = ?')
    .run(contactId, ticket.customer_id);

  let opportunityId = ticket.ghl_opportunity_id;
  if (!opportunityId && config.ghl.pipelineId && config.ghl.stages.new) {
    const opp = await createOpportunity({
      name: `${ticket.ticket_number} · ${ticket.subject}`.slice(0, 120),
      pipelineId: config.ghl.pipelineId,
      stageId: config.ghl.stages[ticket.status] || config.ghl.stages.new,
      contactId,
    });
    opportunityId = opp?.opportunity?.id ?? opp?.id;
    if (opportunityId) updateTicket(ticket.id, { ghl_opportunity_id: opportunityId });
  }

  addEvent(ticket.id, 'ghl_synced', { note: `contact ${contactId}` });
  return { contactId, opportunityId };
}

/** Moves the GHL opportunity to the stage matching the ticket's status. */
export async function syncStatusToGhl(ticket) {
  if (!ticket.ghl_opportunity_id) return null;

  const stageId = config.ghl.stages[ticket.status];
  const patch = {};
  if (stageId) patch.pipelineStageId = stageId;
  if (ticket.status === 'resolved' || ticket.status === 'closed') patch.status = 'won';

  if (Object.keys(patch).length) {
    await updateOpportunity(ticket.ghl_opportunity_id, patch);
  }

  if (ticket.ghl_contact_id) {
    await upsertContact({
      email: ticket.customer_email,
      phone: ticket.customer_phone,
      customFields: ticketCustomFields(ticket),
    });
  }
  return true;
}

// ------------------------------------------------------------ notifications

const wrap = (body) => `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2933;max-width:560px">${body}<p style="color:#7b8794;font-size:13px;margin-top:28px">${config.notify.fromName}</p></div>`;

export const CUSTOMER_TEMPLATES = {
  acknowledged: (t) => ({
    subject: `[${t.ticket_number}] We've received your issue`,
    html: wrap(
      `<p>Hi ${(t.customer_name || 'there').split(' ')[0]},</p>
       <p>Your issue has been escalated to our senior support team and is now tracked as <strong>${t.ticket_number}</strong>.</p>
       <p><strong>What you reported:</strong><br>${escapeHtml(t.subject)}</p>
       <p>A specialist is reviewing it now. You'll hear from us by <strong>${formatDue(t.first_response_due_at)}</strong>.</p>
       <p>Just reply to this email if you have anything to add.</p>`,
    ),
  }),
  pending_customer: (t) => ({
    subject: `[${t.ticket_number}] We need a bit more from you`,
    html: wrap(
      `<p>Hi ${(t.customer_name || 'there').split(' ')[0]},</p>
       <p>We're working on <strong>${t.ticket_number}</strong> and need some more detail from you before we can go further.</p>
       <p>Reply to this email whenever you're ready — we'll pick it straight back up.</p>`,
    ),
  }),
  pending_internal: (t) => ({
    subject: `[${t.ticket_number}] Still on it — status update`,
    html: wrap(
      `<p>Hi ${(t.customer_name || 'there').split(' ')[0]},</p>
       <p>A quick update on <strong>${t.ticket_number}</strong>: this one needs work from our technical team, so it's taking a little longer than a typical request.</p>
       <p>It has not been forgotten. We'll come back to you as soon as we have something concrete.</p>`,
    ),
  }),
  resolved: (t) => ({
    subject: `[${t.ticket_number}] Resolved`,
    html: wrap(
      `<p>Hi ${(t.customer_name || 'there').split(' ')[0]},</p>
       <p>We've resolved <strong>${t.ticket_number}</strong>.</p>
       ${t.resolution_summary ? `<p><strong>What we did:</strong><br>${escapeHtml(t.resolution_summary)}</p>` : ''}
       <p>If it isn't fully sorted, reply here and we'll reopen it right away.</p>`,
    ),
  }),
};

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function formatDue(iso) {
  if (!iso) return 'shortly';
  return new Date(iso).toLocaleString('en-US', {
    dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC',
  }) + ' UTC';
}

export async function notifyCustomer(ticket, templateKey) {
  const template = CUSTOMER_TEMPLATES[templateKey];
  if (!template) throw new Error(`No customer template "${templateKey}"`);
  if (!ticket.ghl_contact_id) return null;

  const { subject, html } = template(ticket);
  await sendEmail({
    contactId: ticket.ghl_contact_id,
    subject,
    html,
    fromName: config.notify.fromName,
    fromEmail: config.notify.fromEmail,
  });
  addEvent(ticket.id, 'customer_notified', { note: templateKey });
  return true;
}

/**
 * Internal alerting. GHL can only send SMS to a *contact*, so the on-call phone
 * must exist as its own contact in the sub-account; `npm run provision` creates
 * it and prints the id for P1_ALERT_CONTACT_ID.
 *
 * Note this sends to the on-call contact, never to the customer.
 */
export async function alertInternal(ticket) {
  if (ticket.severity === 'P1' && config.notify.p1ContactId) {
    try {
      await sendSms({
        contactId: config.notify.p1ContactId,
        message:
          `P1 ESCALATION ${ticket.ticket_number} - ${ticket.subject}\n` +
          `Customer: ${ticket.customer_name || ticket.customer_email || 'unknown'}\n` +
          `Due: ${formatDue(ticket.first_response_due_at)}`,
      });
    } catch (err) {
      // An alert failure must never block ticket creation - the pipeline card
      // and the dashboard are the durable record.
      console.error(`[alert] P1 SMS failed for ${ticket.ticket_number}: ${err.message}`);
    }
  }
  addEvent(ticket.id, 'internal_alerted', {
    note: `${ticket.severity} / ${STATUS_LABELS[ticket.status]}`,
  });
}
