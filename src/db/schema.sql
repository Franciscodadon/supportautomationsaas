PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ghl_contact_id  TEXT UNIQUE,
  email           TEXT,
  phone           TEXT,
  name            TEXT,
  company         TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_email ON customers(email) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS tickets (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_number         TEXT NOT NULL UNIQUE,
  customer_id           INTEGER NOT NULL REFERENCES customers(id),
  ghl_opportunity_id    TEXT,
  status                TEXT NOT NULL DEFAULT 'new',
  severity              TEXT NOT NULL DEFAULT 'P3',
  category              TEXT,
  subject               TEXT NOT NULL,
  description           TEXT NOT NULL,
  steps_taken           TEXT,
  customer_impact       TEXT,
  escalated_by          TEXT,
  source                TEXT NOT NULL DEFAULT 'form',
  assigned_to           TEXT,
  first_response_due_at TEXT,
  first_responded_at    TEXT,
  resolved_at           TEXT,
  closed_at             TEXT,
  resolution_summary    TEXT,
  reopened_count        INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_tickets_status     ON tickets(status);
CREATE INDEX IF NOT EXISTS idx_tickets_created_at ON tickets(created_at);
CREATE INDEX IF NOT EXISTS idx_tickets_customer   ON tickets(customer_id);
CREATE INDEX IF NOT EXISTS idx_tickets_severity   ON tickets(severity);

-- Append-only audit trail. Every status change, note and notification lands here.
-- This is what makes "how long did we sit in Pending?" answerable.
CREATE TABLE IF NOT EXISTS ticket_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  actor       TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_ticket ON ticket_events(ticket_id);
CREATE INDEX IF NOT EXISTS idx_events_type   ON ticket_events(type, created_at);

-- One row per ticket, written by the AI classifier.
CREATE TABLE IF NOT EXISTS ticket_analysis (
  ticket_id           INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  theme               TEXT NOT NULL,
  root_cause_category TEXT NOT NULL,
  sentiment           TEXT NOT NULL,
  urgency_score       INTEGER NOT NULL,
  preventable         INTEGER NOT NULL DEFAULT 0,
  prevention_note     TEXT,
  suggested_reply     TEXT,
  summary             TEXT,
  tags_json           TEXT NOT NULL DEFAULT '[]',
  model               TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_analysis_theme ON ticket_analysis(theme);

-- Canonical theme list. The classifier is shown this list so it reuses existing
-- wording instead of inventing a new phrase for the same problem every time.
CREATE TABLE IF NOT EXISTS themes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  ticket_count INTEGER NOT NULL DEFAULT 0,
  first_seen  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_seen   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS digests (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  period       TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end   TEXT NOT NULL,
  body_md      TEXT NOT NULL,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_digests_period ON digests(period, period_start);
