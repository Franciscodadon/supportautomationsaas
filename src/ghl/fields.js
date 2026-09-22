/**
 * The contact custom fields this system owns in GoHighLevel.
 * `npm run provision` creates any that are missing; it never deletes.
 * fieldKey is what you reference in GHL emails as {{contact.<key>}}.
 */
export const TICKET_FIELDS = [
  { key: 'support_ticket_id',       name: 'Support Ticket ID',        dataType: 'TEXT' },
  { key: 'support_status',          name: 'Support Status',           dataType: 'SINGLE_OPTIONS',
    options: ['New Escalation', 'Active', 'Pending Customer', 'Pending Internal', 'Resolved', 'Closed'] },
  { key: 'support_severity',        name: 'Support Severity',         dataType: 'SINGLE_OPTIONS',
    options: ['P1', 'P2', 'P3', 'P4'] },
  { key: 'support_category',        name: 'Support Category',         dataType: 'TEXT' },
  { key: 'support_subject',         name: 'Support Subject',          dataType: 'TEXT' },
  { key: 'support_summary',         name: 'Escalation Summary',       dataType: 'LARGE_TEXT' },
  { key: 'support_due_at',          name: 'First Response Due',       dataType: 'TEXT' },
  { key: 'support_theme',           name: 'AI Theme',                 dataType: 'TEXT' },
  { key: 'support_resolution',      name: 'Resolution Summary',       dataType: 'LARGE_TEXT' },
];

export const STATUS_FIELD_VALUES = {
  new: 'New Escalation',
  active: 'Active',
  pending_customer: 'Pending Customer',
  pending_internal: 'Pending Internal',
  resolved: 'Resolved',
  closed: 'Closed',
};
