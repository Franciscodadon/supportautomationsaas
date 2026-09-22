# Support Automation

Escalation ticketing, KPI analytics and AI theme mining on top of a GoHighLevel
sub-account.

Level 1 support submits an escalation through a public form. This service turns
it into a tracked ticket against the **customer's** record, opens a card in the
support pipeline, emails the customer, and — in the background — classifies
every escalation so recurring themes, problem accounts and preventable work
surface on their own.

---

## Why a service and not just GoHighLevel

Two reasons, both structural:

1. **A GHL form submission attaches to whoever submits it.** If an L1 agent
   fills in an escalation form, GHL updates *the agent's* contact record, not
   the customer's. Every escalation would collapse onto one contact. This
   service reads the submitted values and upserts the correct customer.
2. **GHL's API cannot create pipelines, forms or workflows** — those endpoints
   are read-only. They are built once in the UI (see
   [`docs/GHL-BUILD-GUIDE.md`](docs/GHL-BUILD-GUIDE.md)); everything at runtime
   is API-driven from here.

What GHL keeps doing well, it keeps doing: the pipeline is the agent's working
view, and customer email and SMS go out through the sub-account so they thread
into the existing conversation history.

---

## What you get

**Ticketing** — every escalation gets a `TKT-00001` number, a severity, a
first-response deadline, and an append-only event history. Statuses are `new`,
`active`, `pending_customer`, `pending_internal`, `resolved`, `closed`.

**Two-way GHL sync** — intake creates the contact, stamps nine custom fields
and opens a pipeline card. Dragging that card fires a workflow webhook back
here, which updates the ticket and emails the customer.

**Customer notifications** — acknowledgment on intake, a nudge when we're
waiting on them, a proactive update when we're blocked internally, and a
resolution note. All from your sub-account, all threaded.

**KPIs** — volume by day/week/month, open backlog by stage, severity mix,
median and average first-response time, SLA compliance, resolution time, reopen
rate, and live SLA breaches.

**AI analysis** — every escalation is classified into a *canonical theme*, a
root cause, a sentiment and an honest urgency score, plus a judgement on whether
better docs, onboarding or L1 training would have prevented it. Themes are
reused rather than reinvented, which is what makes trends countable.

**AI reviews** — daily, weekly and monthly narrative reports over the whole
dataset: what changed, which themes are rising, which accounts are consuming
disproportionate support, where time is being lost, and what to do this week.

---

## Quick start

```bash
npm install
cp .env.example .env      # then fill it in
npm run provision         # creates custom fields, reads your pipeline ids
npm start                 # http://localhost:3000/dashboard
```

To see the dashboard populated before real traffic arrives:

```bash
npm run seed              # 24 demo escalations, local only — never touches GHL
```

Build order: read [`docs/GHL-BUILD-GUIDE.md`](docs/GHL-BUILD-GUIDE.md) first.
Steps 1–2 must happen before `npm run provision` can finish.

---

## Endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/webhook/escalation` | webhook secret | Intake. Point the form workflow here. |
| `POST` | `/webhook/status` | webhook secret | Stage changes coming back from GHL. |
| `GET` | `/dashboard` | basic auth | The KPI dashboard. |
| `GET` | `/api/kpi?days=30` | basic auth | Full metrics snapshot as JSON. |
| `GET` | `/api/tickets` | basic auth | Ticket list, filterable by status/severity. |
| `GET` | `/api/tickets/:number` | basic auth | Ticket, events and AI analysis. |
| `POST` | `/api/tickets/:number/status` | basic auth | Move a ticket from the dashboard. |
| `GET`/`POST` | `/api/digest/:period` | basic auth | Read or generate an AI review. |
| `GET` | `/healthz` | none | Liveness. |

Intake accepts several spellings for each field (`subject` / `issue_subject` /
`title`, `email` / `customer_email`, nested `customData`, …) so the form can be
edited without redeploying. Unknown extra fields are ignored.

---

## Service level targets

| Severity | First response | Typical trigger |
|---|---|---|
| P1 | 1 hour | Service down, revenue blocked |
| P2 | 4 hours | Major feature broken, no workaround |
| P3 | 24 hours | Broken with a workaround |
| P4 | 72 hours | Question, cosmetic, feature request |

Calendar hours, not business hours — escalations are the tier that should not
wait for Monday. Change them in one place: `SLA_HOURS` in `src/core/sla.js`.

---

## Background jobs

Set `RUN_JOBS=1` and the web process also runs: SLA breach detection every 15
minutes, a 48-hour nudge for customers we're waiting on, auto-close of stale
pending and resolved tickets, and the daily/weekly/monthly reviews at 07:00 UTC.

On a host with real cron, leave `RUN_JOBS` off and schedule
`npm run digest -- weekly` instead.

---

## Architecture

```
GHL form ──workflow webhook──▶ POST /webhook/escalation
                                      │
                             ┌────────┴────────┐
                             ▼                 ▼
                      SQLite (source        GHL API
                       of truth)         ├─ upsert customer contact
                             │           ├─ open pipeline card
                             │           ├─ acknowledgment email
                             │           └─ P1 SMS to on-call
                             │
                             ├──▶ AI classify ──▶ theme, root cause, sentiment
                             │
                             └──▶ /dashboard, /api/kpi, AI reviews

GHL pipeline drag ──workflow webhook──▶ POST /webhook/status
                                              └─▶ status + customer email
```

The database is the source of truth, not GHL. GHL is the agent's working
surface and the customer's communication channel. That split is deliberate: it
means analytics never depend on GHL's reporting, and a GHL outage degrades
notifications without losing a single escalation.

**Storage** — SQLite via Node's built-in `node:sqlite` (Node 22.5+). Zero
configuration, one file, and comfortably fast for this volume — a busy agency
desk is thousands of tickets a year, not millions. `DATABASE_PATH` must sit on a
persistent volume; on an ephemeral filesystem the data is lost on redeploy. All
database access goes through `src/db/` and `src/core/`, so moving to Postgres
later touches those two directories only.

`node:sqlite` is still marked experimental in Node 22, which is why you will see
one warning on startup. The API has been stable across 22 and 24; if you would
rather not run on it, `better-sqlite3` is a drop-in for `src/db/index.js`.

---

## Cost

AI analysis defaults to `claude-opus-5` for both classification and reviews.
Classification is one short call per escalation; reviews are one larger call per
period. At a few hundred escalations a month this is small, but it is a real
line item — set `AI_MODEL=claude-sonnet-5` or `claude-haiku-4-5` to cut it, or
`AI_ENABLED=0` to turn analysis off entirely. The ticketing system, the GHL
sync and every KPI except themes and root causes work with AI off.

---

## Security

- Both webhook endpoints require a shared secret (`?token=` or
  `X-Webhook-Secret`), compared without early exit.
- The dashboard and all `/api` routes are behind HTTP basic auth. Put the
  service behind TLS — basic auth over plain HTTP sends the password in clear.
- The GHL token and the Anthropic key are read from the environment only.
  Nothing secret is logged; GHL errors log status and path, not the token.
- Customer-supplied text is escaped everywhere it is rendered, in emails and in
  the dashboard.

---

## Tests

```bash
npm test
```

Covers severity parsing, SLA maths, intake normalization and its failure modes,
the ticket state machine (first-response stamping, replay safety, reopening),
and the KPI aggregates. No network, no GHL, no AI calls.
