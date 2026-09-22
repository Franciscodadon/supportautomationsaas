#!/usr/bin/env node
/**
 * Provisions everything in the GoHighLevel sub-account that the API can create,
 * and verifies everything it cannot.
 *
 * Creates:  the twelve support custom fields on the contact record.
 * Verifies: the Support Escalations pipeline and its stages, then prints the
 *           exact .env lines to paste in.
 *
 * GHL has no write endpoints for pipelines, forms or workflows - those are built
 * once in the UI by following docs/GHL-BUILD-GUIDE.md. This script is safe to
 * re-run: it only creates what is missing and never deletes.
 *
 * Usage: npm run provision
 */
import { config, requireConfig } from '../src/config.js';
import { listCustomFields, createCustomField, listPipelines } from '../src/ghl/client.js';
import { TICKET_FIELDS } from '../src/ghl/fields.js';

const STAGE_MATCHERS = [
  { env: 'GHL_STAGE_NEW',              match: /new|escalat|inbox|triage/i },
  { env: 'GHL_STAGE_ACTIVE',           match: /^active|in progress|working/i },
  { env: 'GHL_STAGE_PENDING_CUSTOMER', match: /pending.*(customer|client)|awaiting.*(customer|client)/i },
  { env: 'GHL_STAGE_PENDING_INTERNAL', match: /pending.*(internal|eng|dev|vendor)|blocked/i },
  { env: 'GHL_STAGE_RESOLVED',         match: /resolved|complete|done|solved/i },
];

const ok = (s) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const warn = (s) => console.log(`  \x1b[33m!\x1b[0m ${s}`);
const fail = (s) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);

async function provisionCustomFields() {
  console.log('\nCustom fields');
  const existing = await listCustomFields('contact');
  const fields = existing?.customFields ?? existing?.customField ?? [];
  const byKey = new Map(
    fields.map((f) => [String(f.fieldKey || f.key || '').replace(/^contact\./, ''), f]),
  );

  const resolved = {};
  for (const spec of TICKET_FIELDS) {
    const found = byKey.get(spec.key);
    if (found) {
      ok(`${spec.key} — already present (${found.id})`);
      resolved[spec.key] = found.id;
      continue;
    }
    try {
      const created = await createCustomField({
        name: spec.name,
        dataType: spec.dataType,
        fieldKey: spec.key,
        options: spec.options,
      });
      const id = created?.customField?.id ?? created?.id;
      ok(`${spec.key} — created (${id})`);
      resolved[spec.key] = id;
    } catch (err) {
      fail(`${spec.key} — ${err.message}`);
    }
  }
  return resolved;
}

async function inspectPipelines() {
  console.log('\nPipelines');
  const result = await listPipelines();
  const pipelines = result?.pipelines ?? [];

  if (!pipelines.length) {
    fail('No pipelines found in this sub-account.');
    warn('Build the pipeline first — see docs/GHL-BUILD-GUIDE.md step 2.');
    return null;
  }

  const support =
    pipelines.find((p) => /support|escalation|ticket/i.test(p.name)) ?? null;

  if (!support) {
    warn(`No support pipeline found. Pipelines present: ${pipelines.map((p) => p.name).join(', ')}`);
    warn('Create one named "Support Escalations" — see docs/GHL-BUILD-GUIDE.md step 2.');
    return null;
  }

  ok(`Found "${support.name}" (${support.id})`);
  const stages = support.stages ?? [];
  const envLines = [`GHL_PIPELINE_ID=${support.id}`];

  for (const { env, match } of STAGE_MATCHERS) {
    const stage = stages.find((s) => match.test(s.name));
    if (stage) {
      ok(`${env} → "${stage.name}"`);
      envLines.push(`${env}=${stage.id}`);
    } else {
      fail(`${env} — no stage matched. Stages present: ${stages.map((s) => s.name).join(', ')}`);
      envLines.push(`${env}=   # <- fill in manually`);
    }
  }
  return envLines;
}

async function main() {
  requireConfig(['ghl.apiKey', 'ghl.locationId']);
  console.log(`Provisioning GHL location ${config.ghl.locationId}`);

  await provisionCustomFields();
  const envLines = await inspectPipelines();

  console.log('\n' + '─'.repeat(64));
  if (envLines) {
    console.log('Paste these into your .env:\n');
    console.log(envLines.join('\n'));
  } else {
    console.log('Build the pipeline in the UI, then re-run `npm run provision`.');
  }
  console.log('─'.repeat(64));
  console.log('\nStill to do by hand (no API exists for these):');
  console.log('  1. The escalation form           — docs/GHL-BUILD-GUIDE.md step 3');
  console.log('  2. The intake workflow (webhook) — docs/GHL-BUILD-GUIDE.md step 4');
  console.log('  3. The stage-change workflows    — docs/GHL-BUILD-GUIDE.md step 5');
}

main().catch((err) => {
  console.error(`\n\x1b[31mProvisioning failed:\x1b[0m ${err.message}`);
  if (err.status === 401) console.error('That looks like a bad or expired Private Integration token.');
  if (err.status === 403) console.error('The token is missing a required scope — see .env.example.');
  process.exit(1);
});
