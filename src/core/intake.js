import { normalizeSeverity } from './sla.js';

/**
 * GHL form/webhook payloads are not consistently shaped: field names depend on
 * how the form was built, and custom fields may be nested under `customData`.
 * This flattens whatever arrives into the ticket shape, accepting several
 * spellings for each field so the form can be edited without redeploying.
 */
const ALIASES = {
  customerEmail: ['customer_email', 'customerEmail', 'email', 'contact_email'],
  customerName: ['customer_name', 'customerName', 'full_name', 'name', 'contact_name'],
  customerPhone: ['customer_phone', 'customerPhone', 'phone'],
  customerCompany: ['customer_company', 'company', 'companyName', 'account', 'organization'],
  subject: ['subject', 'issue_subject', 'title', 'summary', 'issue'],
  description: ['description', 'issue_description', 'details', 'problem', 'message', 'escalation_summary'],
  stepsTaken: ['steps_taken', 'stepsTaken', 'steps_already_taken', 'l1_notes', 'troubleshooting'],
  customerImpact: ['customer_impact', 'customerImpact', 'impact', 'business_impact'],
  severity: ['severity', 'priority', 'urgency'],
  category: ['category', 'issue_type', 'type', 'product_area'],
  escalatedBy: ['escalated_by', 'escalatedBy', 'agent', 'agent_name', 'submitted_by', 'l1_agent'],
  ghlContactId: ['contact_id', 'contactId', 'ghl_contact_id'],
};

function flatten(payload) {
  const flat = {};
  const merge = (obj) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object' && !Array.isArray(v)) merge(v);
      else if (flat[k] === undefined) flat[k] = v;
    }
  };
  merge(payload);
  return flat;
}

const pick = (flat, keys) => {
  for (const key of keys) {
    const match = Object.keys(flat).find((k) => k.toLowerCase() === key.toLowerCase());
    if (match && flat[match] !== null && String(flat[match]).trim() !== '') {
      return String(flat[match]).trim();
    }
  }
  return undefined;
};

export class IntakeError extends Error {
  constructor(message, fields) {
    super(message);
    this.name = 'IntakeError';
    this.fields = fields;
  }
}

export function normalizeIntake(payload, { source = 'form' } = {}) {
  const flat = flatten(payload);
  const out = { source };
  for (const [field, keys] of Object.entries(ALIASES)) out[field] = pick(flat, keys);

  const missing = [];
  if (!out.subject) missing.push('subject');
  if (!out.description) missing.push('description');
  if (!out.customerEmail && !out.customerPhone && !out.ghlContactId) {
    missing.push('customer_email or customer_phone');
  }
  if (missing.length) {
    throw new IntakeError(`Escalation is missing required fields: ${missing.join(', ')}`, missing);
  }

  out.severity = normalizeSeverity(out.severity);
  // Guard against a pasted log blowing up the record or the AI call.
  if (out.description.length > 20000) out.description = `${out.description.slice(0, 20000)}\n[truncated]`;
  out.subject = out.subject.slice(0, 300);

  return out;
}
