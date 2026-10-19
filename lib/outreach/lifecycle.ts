import type { MessageStatus } from '@/lib/constants/outreach';

/**
 * Status transitions for an outreach message.
 *
 * The database trigger outreach_messages_guard() enforces the same rules; this
 * copy exists so the API can answer with a clear message instead of a
 * constraint error, and so the UI only offers actions that will succeed.
 */
export type MessageAction = 'approve' | 'unapprove' | 'mark_sent' | 'archive' | 'restore';

const TRANSITIONS: Record<MessageAction, { from: readonly MessageStatus[]; to: MessageStatus }> = {
  approve: { from: ['draft', 'archived'], to: 'approved' },
  unapprove: { from: ['approved'], to: 'draft' },
  // Only an explicit "Mark as sent" reaches this. Copying never does.
  mark_sent: { from: ['approved'], to: 'sent' },
  archive: { from: ['draft', 'approved'], to: 'archived' },
  restore: { from: ['archived'], to: 'draft' },
};

const REFUSALS: Record<MessageAction, string> = {
  approve: 'Only a draft can be approved.',
  unapprove: 'Only an approved message can be moved back to draft.',
  mark_sent: 'Approve the message before marking it as sent.',
  archive: 'A sent message is kept as a record and cannot be archived.',
  restore: 'Only an archived message can be restored.',
};

export type TransitionResult = { ok: true; status: MessageStatus } | { ok: false; reason: string };

export function applyMessageAction(current: MessageStatus, action: MessageAction): TransitionResult {
  const rule = TRANSITIONS[action];
  return rule.from.includes(current)
    ? { ok: true, status: rule.to }
    : { ok: false, reason: REFUSALS[action] };
}

export function allowedActions(current: MessageStatus): MessageAction[] {
  return (Object.keys(TRANSITIONS) as MessageAction[]).filter((action) =>
    TRANSITIONS[action].from.includes(current),
  );
}

/** A planned send time can be set or cleared until the message is sent. */
export function canSchedule(current: MessageStatus): boolean {
  return current !== 'sent';
}

/** Text can be edited until the message is sent. Editing an approved one re-drafts it. */
export function canEditBody(current: MessageStatus): boolean {
  return current !== 'sent';
}
