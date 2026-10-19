'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Alert, Badge, Button, Card, cx } from '@/components/ui';
import { ApiRequestError, apiFetch } from '@/lib/api/client';
import {
  MESSAGE_CHANNEL_LABELS,
  MESSAGE_MAX_LENGTH,
  MESSAGE_STATUS_LABELS,
  MESSAGE_STATUS_STYLES,
} from '@/lib/constants/outreach';
import { allowedActions, canEditBody, type MessageAction } from '@/lib/outreach/lifecycle';
import type { OutreachMessage, OutreachMessageWithLead } from '@/types/database';

const ACTION_LABELS: Record<MessageAction, string> = {
  approve: 'Approve',
  unapprove: 'Back to draft',
  mark_sent: 'Mark as sent',
  archive: 'Archive',
  restore: 'Restore',
};

/**
 * One outreach message: read, edit, approve, copy, mark as sent.
 *
 * Copy only puts the text on the clipboard. It never changes the message —
 * the user marks it as sent themselves once they have actually sent it.
 */
export function MessageCard({
  message,
  onChange,
  onDelete,
}: {
  message: OutreachMessage | OutreachMessageWithLead;
  onChange: (message: OutreachMessage) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmSent, setConfirmSent] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const lead = 'lead' in message ? message.lead : null;
  const max = MESSAGE_MAX_LENGTH[message.channel];
  const actions = allowedActions(message.status);

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const data = await apiFetch<{ message: OutreachMessage }>(`/api/messages/${message.id}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      onChange(data.message);
      return true;
    } catch (err) {
      setError(
        err instanceof ApiRequestError
          ? (err.fields?.body?.[0] ?? err.message)
          : 'Could not update the message.',
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (await send({ action: 'edit', body: draft })) setEditing(false);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(message.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Could not copy to the clipboard. Select the text and copy it by hand.');
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await apiFetch(`/api/messages/${message.id}`, { method: 'DELETE' });
      onDelete(message.id);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not delete the message.');
      setBusy(false);
      setConfirmDelete(false);
    }
  }

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge className={MESSAGE_STATUS_STYLES[message.status]}>
          {MESSAGE_STATUS_LABELS[message.status]}
        </Badge>
        <span className="text-xs text-slate-500">{MESSAGE_CHANNEL_LABELS[message.channel]}</span>
        <span className="text-xs text-slate-400">
          · {message.source === 'ai' ? (message.edited ? 'AI draft, edited' : 'AI draft') : 'Written by hand'}
        </span>
        {lead && (
          <Link
            href={`/leads/${lead.id}`}
            className="ml-auto truncate text-sm font-medium text-brand-700 hover:underline"
          >
            {lead.full_name}
            {lead.company_name ? ` · ${lead.company_name}` : ''}
          </Link>
        )}
      </div>

      {error && (
        <div className="mt-3">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {editing ? (
        <div className="mt-3">
          <label htmlFor={`body-${message.id}`} className="sr-only">
            Message text
          </label>
          <textarea
            id={`body-${message.id}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={message.channel === 'connection_request' ? 4 : 8}
            className="field-input resize-y"
          />
          <p
            className={cx(
              'mt-1 text-xs',
              draft.trim().length > max ? 'text-rose-600' : 'text-slate-500',
            )}
          >
            {draft.trim().length} / {max} characters
            {message.status === 'approved' && ' · Saving new text moves it back to draft.'}
          </p>
        </div>
      ) : (
        <p className="mt-3 whitespace-pre-wrap break-words text-sm text-slate-800">{message.body}</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <Button
              size="sm"
              onClick={() => void saveEdit()}
              loading={busy}
              disabled={draft.trim().length === 0 || draft.trim().length > max}
            >
              Save
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setDraft(message.body);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" variant="secondary" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy text'}
            </Button>
            {canEditBody(message.status) && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setDraft(message.body);
                  setEditing(true);
                }}
              >
                Edit
              </Button>
            )}
            {actions.map((action) => (
              <Button
                key={action}
                size="sm"
                variant={action === 'approve' || action === 'mark_sent' ? 'primary' : 'ghost'}
                disabled={busy}
                onClick={() =>
                  action === 'mark_sent' ? setConfirmSent(true) : void send({ action })
                }
              >
                {ACTION_LABELS[action]}
              </Button>
            ))}
            {lead?.linkedin_url && (
              <a
                href={lead.linkedin_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-medium text-brand-600 hover:underline"
              >
                Open profile
              </a>
            )}
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="ml-auto text-xs text-slate-400 hover:text-rose-600"
            >
              Delete
            </button>
          </>
        )}
      </div>

      {message.sent_at && (
        <p className="mt-2 text-xs text-slate-500">
          Marked as sent {new Date(message.sent_at).toLocaleString('en-GB')}
        </p>
      )}

      <Modal
        open={confirmSent}
        onClose={() => setConfirmSent(false)}
        title="Mark as sent"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmSent(false)}>
              Not yet
            </Button>
            <Button
              loading={busy}
              onClick={async () => {
                if (await send({ action: 'mark_sent' })) setConfirmSent(false);
              }}
            >
              I have sent it
            </Button>
          </>
        }
      >
        Only confirm once you have actually sent this on LinkedIn. The message is then locked as a
        record, and a lead at New or Qualified moves to Contacted.
      </Modal>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete message"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void remove()} loading={busy}>
              Delete
            </Button>
          </>
        }
      >
        Delete this message? This cannot be undone.
      </Modal>
    </Card>
  );
}
