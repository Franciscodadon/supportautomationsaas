import fs from 'node:fs';
import path from 'node:path';

// Minimal .env loader so the service runs with no extra dependency.
// Real env vars always win over the file.
function loadDotEnv(file = '.env') {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(process.env.DOTENV_PATH || '.env');

const bool = (v, fallback = false) =>
  v === undefined ? fallback : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

export const config = {
  port: Number(process.env.PORT || 3000),
  databasePath: process.env.DATABASE_PATH || './data/support.db',
  webhookSecret: process.env.WEBHOOK_SECRET || '',
  dashboard: {
    user: process.env.DASHBOARD_USER || 'support',
    password: process.env.DASHBOARD_PASSWORD || '',
  },
  ghl: {
    apiKey: process.env.GHL_API_KEY || '',
    locationId: process.env.GHL_LOCATION_ID || '',
    pipelineId: process.env.GHL_PIPELINE_ID || '',
    stages: {
      new: process.env.GHL_STAGE_NEW || '',
      active: process.env.GHL_STAGE_ACTIVE || '',
      pending_customer: process.env.GHL_STAGE_PENDING_CUSTOMER || '',
      pending_internal: process.env.GHL_STAGE_PENDING_INTERNAL || '',
      resolved: process.env.GHL_STAGE_RESOLVED || '',
    },
  },
  ai: {
    enabled: bool(process.env.AI_ENABLED, true) && Boolean(process.env.ANTHROPIC_API_KEY),
    model: process.env.AI_MODEL || 'claude-opus-5',
  },
  notify: {
    fromEmail: process.env.SUPPORT_FROM_EMAIL || '',
    fromName: process.env.SUPPORT_FROM_NAME || 'Support Team',
    internalEmails: (process.env.INTERNAL_ALERT_EMAILS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    p1ContactId: process.env.P1_ALERT_CONTACT_ID || '',
  },
};

/** Throws with a readable list if anything required for a given mode is missing. */
export function requireConfig(keys) {
  const missing = [];
  for (const key of keys) {
    const value = key.split('.').reduce((o, k) => (o ?? {})[k], config);
    if (!value) missing.push(key);
  }
  if (missing.length) {
    throw new Error(
      `Missing required configuration: ${missing.join(', ')}.\n` +
        `Set them in .env (copy .env.example) or as environment variables.`,
    );
  }
}

export function ensureDataDir() {
  const dir = path.dirname(config.databasePath);
  if (dir && dir !== '.' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}
