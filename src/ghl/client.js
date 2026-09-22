import { config } from '../config.js';

const BASE_URL = 'https://services.leadconnectorhq.com';
const API_VERSION = '2021-07-28';

export class GhlError extends Error {
  constructor(message, { status, body, path } = {}) {
    super(message);
    this.name = 'GhlError';
    this.status = status;
    this.body = body;
    this.path = path;
  }
}

/**
 * Thin wrapper over the GHL v2 REST API.
 *
 * Retries on 429 and 5xx with exponential backoff - GHL rate-limits at roughly
 * 100 requests per 10s per location, which a burst of escalations can hit.
 */
export async function ghlRequest(path, { method = 'GET', body, query, retries = 3 } = {}) {
  if (!config.ghl.apiKey) {
    throw new GhlError('GHL_API_KEY is not set - cannot call GoHighLevel.', { path });
  }

  const url = new URL(path.startsWith('http') ? path : `${BASE_URL}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${config.ghl.apiKey}`,
          Version: API_VERSION,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      lastError = new GhlError(`Network error calling ${path}: ${err.message}`, { path });
      await backoff(attempt);
      continue;
    }

    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }

    if (response.ok) return parsed;

    if (response.status === 429 || response.status >= 500) {
      lastError = new GhlError(`GHL ${response.status} on ${method} ${path}`, {
        status: response.status,
        body: parsed,
        path,
      });
      await backoff(attempt);
      continue;
    }

    // 4xx other than 429 will not get better by retrying.
    throw new GhlError(
      `GHL ${response.status} on ${method} ${path}: ${
        typeof parsed === 'string' ? parsed : JSON.stringify(parsed)
      }`,
      { status: response.status, body: parsed, path },
    );
  }
  throw lastError;
}

const backoff = (attempt) => new Promise((r) => setTimeout(r, 2 ** attempt * 500));

// ---------------------------------------------------------------- contacts

export function upsertContact({ email, phone, firstName, lastName, companyName, tags, customFields }) {
  return ghlRequest('/contacts/upsert', {
    method: 'POST',
    body: {
      locationId: config.ghl.locationId,
      email: email || undefined,
      phone: phone || undefined,
      firstName: firstName || undefined,
      lastName: lastName || undefined,
      companyName: companyName || undefined,
      tags: tags?.length ? tags : undefined,
      customFields: customFields?.length ? customFields : undefined,
    },
  });
}

export function getContact(contactId) {
  return ghlRequest(`/contacts/${contactId}`);
}

// ----------------------------------------------------------- custom fields

export function listCustomFields(model = 'contact') {
  return ghlRequest(`/locations/${config.ghl.locationId}/customFields`, { query: { model } });
}

export function createCustomField({ name, dataType, fieldKey, placeholder, options, model = 'contact' }) {
  return ghlRequest(`/locations/${config.ghl.locationId}/customFields`, {
    method: 'POST',
    body: {
      name,
      dataType,
      fieldKey,
      placeholder: placeholder || undefined,
      options: options?.length ? options : undefined,
      model,
    },
  });
}

// --------------------------------------------------------------- pipelines

export function listPipelines() {
  return ghlRequest('/opportunities/pipelines', { query: { locationId: config.ghl.locationId } });
}

// ------------------------------------------------------------ opportunities

export function createOpportunity({ name, pipelineId, stageId, contactId, monetaryValue = 0, status = 'open' }) {
  return ghlRequest('/opportunities/', {
    method: 'POST',
    body: {
      locationId: config.ghl.locationId,
      pipelineId,
      pipelineStageId: stageId,
      contactId,
      name,
      status,
      monetaryValue,
    },
  });
}

export function updateOpportunity(opportunityId, patch) {
  return ghlRequest(`/opportunities/${opportunityId}`, { method: 'PUT', body: patch });
}

// ------------------------------------------------------------- conversations

export function sendEmail({ contactId, subject, html, fromName, fromEmail }) {
  return ghlRequest('/conversations/messages', {
    method: 'POST',
    body: {
      type: 'Email',
      contactId,
      subject,
      html,
      emailFrom: fromEmail ? `${fromName || 'Support'} <${fromEmail}>` : undefined,
    },
  });
}

export function sendSms({ contactId, message }) {
  return ghlRequest('/conversations/messages', {
    method: 'POST',
    body: { type: 'SMS', contactId, message },
  });
}
