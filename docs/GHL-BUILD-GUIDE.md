# GoHighLevel build guide

Everything in this document is UI work in your sub-account. It exists because
GoHighLevel's API v2 has **no write endpoints for pipelines, forms or
workflows** — they can only be read. Custom fields and everything at runtime
(contacts, opportunities, stage moves, emails, SMS) *are* API-driven and are
handled by `npm run provision` and the service itself.

Budget about 30 minutes. Do the steps in order; later steps reference ids
produced by earlier ones.

---

## Step 1 — Private Integration token

**Settings → Private Integrations → Create new integration**

Name it `Support Automation`. Tick these scopes and nothing else:

```
contacts.readonly                    contacts.write
opportunities.readonly               opportunities.write
locations/customFields.readonly      locations/customFields.write
locations/customValues.readonly      locations/customValues.write
conversations.readonly               conversations.write
conversations/message.readonly       conversations/message.write
users.readonly
```

Copy the token (`pit-…`) into `.env` as `GHL_API_KEY`. It is shown once.

Your location id is in the browser URL while you are in the sub-account:
`app.gohighlevel.com/v2/location/<THIS_PART>/…` → `GHL_LOCATION_ID`.

> The token grants full read/write on contacts and conversations for this
> sub-account. Treat it like a password: environment variable only, never in
> source control, rotate it if it is ever pasted somewhere shared.

---

## Step 2 — The pipeline

**Opportunities → Pipelines → Create new pipeline**

Name: **Support Escalations**

Create exactly these five stages, in this order:

| # | Stage name | Meaning |
|---|---|---|
| 1 | `New Escalation` | Nobody has touched it. The SLA clock is running. |
| 2 | `Active` | Owned by a named agent, being worked right now. |
| 3 | `Pending Customer` | We are blocked on the customer. |
| 4 | `Pending Internal` | We are blocked on engineering, a vendor, or a fix. |
| 5 | `Resolved` | Fixed and communicated. Auto-closes after 5 days. |

Turn **off** "Allow opportunities to be moved back" if you want a strict flow;
leave it on if agents should be able to drag freely. The service handles both.

**Why the two Pending stages are separate:** collapsing them into one hides the
single most useful number you have — whether your backlog is waiting on *them*
or on *you*. One is a follow-up problem, the other is a capacity problem, and
they need opposite fixes. Do not merge them.

Now run:

```bash
npm run provision
```

It creates the nine support custom fields, reads your pipeline back, and
prints the `GHL_PIPELINE_ID` / `GHL_STAGE_*` lines to paste into `.env`.

---

## Step 3 — The escalation form

**Sites → Forms → Builder → Create new form**

Name: **Support Escalation (L1 → L2)**

Add these fields. The **field name / custom-field key** column is what matters —
the service matches on it, and it accepts several spellings, so exact labels are
up to you.

| Field | Type | Key | Required |
|---|---|---|---|
| Customer name | Text | `customer_name` | yes |
| Customer email | Email | `customer_email` | yes* |
| Customer phone | Phone | `customer_phone` | no* |
| Company / account | Text | `customer_company` | no |
| Issue subject | Text | `subject` | yes |
| What is happening | Textarea | `description` | yes |
| Severity | Dropdown | `severity` | yes |
| Category | Dropdown | `category` | no |

\* Email **or** phone must be present — that is how the customer is identified.

Severity dropdown options (paste verbatim; the service maps them to P1–P4):

```
Critical - service down or revenue blocked
High - major feature broken, no workaround
Normal - broken but there is a workaround
Low - question, cosmetic, or feature request
```

Category dropdown — start with these and add your own over time:

```
Authentication   Billing   Integrations   Reporting
Calendar         Performance   Data        How-to   Other
```

**Important:** this form collects the *customer's* details as data entered by
the agent. It does **not** attach the submission to the customer's contact
record — GHL attaches a submission to whoever submits it. That is exactly why
the webhook service exists: it reads these values and upserts the correct
customer contact itself.

Publish the form and copy its public link. That link is what your L1 team uses.

---

## Step 4 — The intake workflow

**Automation → Workflows → Create Workflow → Start from scratch**

Name: **Support · Escalation Intake**

**Trigger:** `Form Submitted` → select *Support Escalation (L1 → L2)*

**Action:** `Webhook`
- Method: `POST`
- URL: `https://your-service-url/webhook/escalation?token=YOUR_WEBHOOK_SECRET`
- Body: leave as the default (GHL posts the full submission payload)

That is the entire workflow. One trigger, one action. Everything downstream —
creating the customer contact, minting the ticket number, opening the pipeline
card, the acknowledgment email, the P1 SMS, the AI analysis — happens in the
service.

Publish the workflow.

> Use the same `WEBHOOK_SECRET` value here as in `.env`. Without it the endpoint
> returns 401, which is what stops anyone who finds the URL from opening tickets.

---

## Step 5 — Stage-change workflows

These are what let an agent drag a card in GHL and have the customer emailed
automatically. Create **one workflow per stage** — four in total.

For each, the shape is identical:

**Trigger:** `Opportunity Status Changed` (or `Pipeline Stage Changed`)
- Pipeline: `Support Escalations`
- Stage: *the stage this workflow is for*

**Action:** `Webhook` → `POST` to
`https://your-service-url/webhook/status?token=YOUR_WEBHOOK_SECRET`

with a **custom JSON body**:

```json
{
  "ticket_number": "{{contact.support_ticket_id}}",
  "status": "active",
  "actor": "{{user.name}}"
}
```

Change only the `status` value per workflow:

| Workflow name | Stage | `status` value |
|---|---|---|
| Support · Stage Active | Active | `active` |
| Support · Stage Pending Customer | Pending Customer | `pending_customer` |
| Support · Stage Pending Internal | Pending Internal | `pending_internal` |
| Support · Stage Resolved | Resolved | `resolved` |

The service sends the matching customer email for `pending_customer`,
`pending_internal` and `resolved`, writes the audit event, and stops the SLA
clock on the first move off `New Escalation`.

You do not need a workflow for `New Escalation` — intake already creates the
card there.

---

## Step 6 — Internal alerting (optional but recommended)

**Contacts → Add contact**

Create one contact named `Support On-Call` with the phone number that should
receive P1 SMS alerts. Copy its contact id from the URL and set it as
`P1_ALERT_CONTACT_ID` in `.env`.

GHL can only send SMS to a *contact*, so an internal alert needs an internal
contact. This is the reason for the extra step — and it is also what keeps the
P1 alert from ever going to the customer.

---

## Step 7 — Verify the whole loop

```bash
curl -X POST "https://your-service-url/webhook/escalation?token=YOUR_WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{"customer_name":"Test Customer","customer_email":"you@yourdomain.com",
       "subject":"End to end test","description":"Checking the pipeline.",
       "severity":"Normal - broken but there is a workaround"}'
```

You should see, within about ten seconds:

1. A JSON response with a `ticket_number`.
2. A new contact in GHL with the support custom fields populated.
3. A card in **New Escalation** named `TKT-00001 · End to end test`.
4. An acknowledgment email in that address's inbox.
5. The ticket on your dashboard at `/dashboard`.

Then drag the card to **Active** and confirm the dashboard status updates.

If step 2 or 3 does not happen, check the service logs — the API error from GHL
is logged verbatim, and a 403 there always means a missing scope from step 1.
