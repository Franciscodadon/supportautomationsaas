import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { nowIso, daysAgoIso } from '../core/time.js';
import {
  volumeSummary, statusBreakdown, severityBreakdown, responseMetrics,
  themeTrends, rootCauseBreakdown, topCustomers, preventableShare,
} from '../core/kpi.js';

const client = config.ai.enabled ? new Anthropic() : null;

const SYSTEM_PROMPT = `You are the support operations analyst for an agency's escalation desk. You are handed a period's worth of escalation data and you write the review that the support lead actually acts on.

Rules:
- Lead with what changed, not with what the numbers are. The reader can see the numbers.
- Every recommendation must be specific enough to assign to a person this week. "Improve documentation" is useless. "Write a one-page guide for the SSO redirect-URI mismatch, which caused 9 escalations this month" is useful.
- Name the accounts that are consuming disproportionate support, and say whether the pattern looks like a product problem, an onboarding problem, or an at-risk relationship.
- Call out what would let Level 1 close these without escalating - that is the single highest-leverage output of this report.
- If the data is too thin to support a conclusion, say so plainly instead of inventing a trend. A small sample is a real and common situation.
- Be direct. No filler, no congratulation, no restating the brief.

Write in Markdown with these sections, in order:
## Headline
## What changed this period
## Recurring themes
## Accounts to watch
## Where we are losing time
## Do this week
Keep the whole thing under 700 words.`;

/** Assembles the full statistical picture that the model reasons over. */
export function collectMetrics(days) {
  const db = getDb();
  const since = daysAgoIso(days);

  const sampleTickets = db
    .prepare(
      `SELECT t.ticket_number, t.severity, t.status, t.subject, t.created_at,
              c.company, c.name AS customer_name,
              a.theme, a.root_cause_category, a.sentiment, a.preventable, a.prevention_note
       FROM tickets t
       JOIN customers c ON c.id = t.customer_id
       LEFT JOIN ticket_analysis a ON a.ticket_id = t.id
       WHERE t.created_at >= ?
       ORDER BY t.created_at DESC LIMIT 120`,
    )
    .all(since);

  const preventionNotes = db
    .prepare(
      `SELECT a.prevention_note, COUNT(*) AS n
       FROM ticket_analysis a JOIN tickets t ON t.id = a.ticket_id
       WHERE t.created_at >= ? AND a.preventable = 1 AND a.prevention_note IS NOT NULL
       GROUP BY a.prevention_note ORDER BY n DESC LIMIT 25`,
    )
    .all(since);

  return {
    window_days: days,
    volume: volumeSummary(),
    status: statusBreakdown(),
    severity: severityBreakdown(days),
    performance: responseMetrics(days),
    themes: themeTrends(days, 20),
    root_causes: rootCauseBreakdown(days),
    top_customers: topCustomers(days, 12),
    preventable: preventableShare(days),
    prevention_notes: preventionNotes,
    sample_tickets: sampleTickets,
  };
}

/**
 * Generates and stores a narrative digest for the period.
 * `period` is one of 'daily' | 'weekly' | 'monthly'.
 */
export async function generateDigest(period = 'weekly') {
  const days = { daily: 1, weekly: 7, monthly: 30 }[period] ?? 7;
  const metrics = collectMetrics(days);

  if (metrics.volume.all_time === 0) {
    return { period, body_md: '_No escalations recorded yet._', metrics };
  }
  if (!client) {
    return {
      period,
      body_md: '_AI analysis is disabled (set ANTHROPIC_API_KEY and AI_ENABLED=1)._',
      metrics,
    };
  }

  let response;
  try {
    response = await client.messages.create({
      model: config.ai.model,
      max_tokens: 8000,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content:
            `Write the ${period} escalation review covering the last ${days} day(s).\n\n` +
            `Here is the data as JSON:\n\n${JSON.stringify(metrics, null, 2)}`,
        },
      ],
    });
  } catch (err) {
    console.error(`[ai] digest failed: ${err.message}`);
    return { period, body_md: `_Digest generation failed: ${err.message}_`, metrics };
  }

  if (response.stop_reason === 'refusal') {
    return { period, body_md: '_The model declined to generate this digest._', metrics };
  }

  const body = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  getDb()
    .prepare(
      `INSERT INTO digests (period, period_start, period_end, body_md, metrics_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(period, daysAgoIso(days), nowIso(), body, JSON.stringify(metrics));

  return { period, body_md: body, metrics };
}

export function latestDigest(period = 'weekly') {
  return getDb()
    .prepare('SELECT * FROM digests WHERE period = ? ORDER BY created_at DESC LIMIT 1')
    .get(period);
}
