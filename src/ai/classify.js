import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { nowIso } from '../core/time.js';

const client = config.ai.enabled ? new Anthropic() : null;

const ROOT_CAUSES = [
  'product_bug',
  'product_limitation',
  'configuration_error',
  'user_education',
  'documentation_gap',
  'onboarding_gap',
  'billing_or_account',
  'third_party_integration',
  'performance',
  'process_failure_our_side',
  'other',
];

const AnalysisSchema = z.object({
  theme: z
    .string()
    .describe(
      'Short canonical label for what this escalation is really about, 2-5 words, ' +
        'Title Case. Reuse an existing theme verbatim when one fits.',
    ),
  root_cause_category: z.enum(ROOT_CAUSES),
  sentiment: z.enum(['calm', 'neutral', 'concerned', 'frustrated', 'angry']),
  urgency_score: z
    .number()
    .int()
    .min(1)
    .max(10)
    .describe('How urgent this genuinely is on the evidence, independent of the stated severity.'),
  preventable: z
    .boolean()
    .describe('True if better docs, onboarding, product design or L1 training would have avoided this escalation entirely.'),
  prevention_note: z
    .string()
    .describe('One sentence: the specific change that would have prevented it. Empty string if not preventable.'),
  suggested_reply: z
    .string()
    .describe('A short draft reply the support agent could send to the customer right now. Plain text, no greeting boilerplate.'),
  summary: z.string().describe('One sentence stating the problem, for scanning a list.'),
  tags: z.array(z.string()).max(5).describe('Lowercase kebab-case tags, e.g. "sso-login".'),
});

const SYSTEM_PROMPT = `You are the analyst for a support escalation desk. You read escalations that Level 1 support could not resolve and extract structured signal from them.

You care about three things:
1. Naming the underlying problem consistently, so repeat issues are countable. The theme is the unit of trend analysis - if two tickets describe the same underlying problem in different words, they must get the SAME theme string.
2. Honest root cause. "user_education" and "documentation_gap" are not insults; correctly labelling them is how the team fixes the real bottleneck. Do not default to product_bug.
3. Judging urgency from the described impact, not from how loudly it is written. A calm message describing a total outage is urgent. An angry message about a cosmetic issue is not.

Reuse existing themes wherever one genuinely fits. Only invent a new theme when nothing in the list describes this problem.`;

/** Returns the current canonical theme list, most-used first. */
export function knownThemes(limit = 60) {
  return getDb()
    .prepare('SELECT name, ticket_count FROM themes ORDER BY ticket_count DESC LIMIT ?')
    .all(limit);
}

function recordTheme(name) {
  const db = getDb();
  db.prepare(
    `INSERT INTO themes (name, ticket_count, last_seen) VALUES (?, 1, ?)
     ON CONFLICT(name) DO UPDATE SET ticket_count = ticket_count + 1, last_seen = excluded.last_seen`,
  ).run(name, nowIso());
}

/**
 * Classifies one ticket and stores the result. Returns null when AI is off or
 * the model declines - analysis is an enhancement, never a hard dependency of
 * the ticketing system.
 */
export async function classifyTicket(ticket) {
  if (!client) return null;

  const themes = knownThemes();
  const themeList = themes.length
    ? themes.map((t) => `- ${t.name} (${t.ticket_count} tickets)`).join('\n')
    : '(none yet - you are naming the first theme)';

  const userContent = `EXISTING THEMES - reuse one of these verbatim if it fits:
${themeList}

---
ESCALATION ${ticket.ticket_number}
Stated severity: ${ticket.severity}
Category: ${ticket.category || 'not set'}
Customer: ${ticket.customer_name || 'unknown'}${ticket.customer_company ? ` (${ticket.customer_company})` : ''}

Subject: ${ticket.subject}

Description:
${ticket.description}`;

  let response;
  try {
    response = await client.messages.parse({
      model: config.ai.model,
      max_tokens: 4000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
      output_config: { format: zodOutputFormat(AnalysisSchema, 'escalation_analysis') },
    });
  } catch (err) {
    console.error(`[ai] classify failed for ${ticket.ticket_number}: ${err.message}`);
    return null;
  }

  if (response.stop_reason === 'refusal') {
    console.warn(`[ai] model declined to analyze ${ticket.ticket_number}`);
    return null;
  }

  const analysis = response.parsed_output;
  if (!analysis) {
    console.warn(`[ai] no parsed output for ${ticket.ticket_number}`);
    return null;
  }

  const db = getDb();
  db.prepare(
    `INSERT INTO ticket_analysis (
       ticket_id, theme, root_cause_category, sentiment, urgency_score,
       preventable, prevention_note, suggested_reply, summary, tags_json, model
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ticket_id) DO UPDATE SET
       theme = excluded.theme, root_cause_category = excluded.root_cause_category,
       sentiment = excluded.sentiment, urgency_score = excluded.urgency_score,
       preventable = excluded.preventable, prevention_note = excluded.prevention_note,
       suggested_reply = excluded.suggested_reply, summary = excluded.summary,
       tags_json = excluded.tags_json, model = excluded.model`,
  ).run(
    ticket.id,
    analysis.theme,
    analysis.root_cause_category,
    analysis.sentiment,
    analysis.urgency_score,
    analysis.preventable ? 1 : 0,
    analysis.prevention_note || null,
    analysis.suggested_reply || null,
    analysis.summary || null,
    JSON.stringify(analysis.tags ?? []),
    config.ai.model,
  );
  recordTheme(analysis.theme);

  return analysis;
}

export function getAnalysis(ticketId) {
  return getDb().prepare('SELECT * FROM ticket_analysis WHERE ticket_id = ?').get(ticketId);
}
