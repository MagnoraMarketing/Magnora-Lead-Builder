'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Button, Card, CardBody, CardHeader, Spinner } from '@/components/ui';
import { ApiRequestError, apiFetch } from '@/lib/api/client';
import {
  MESSAGE_CHANNELS,
  MESSAGE_CHANNEL_LABELS,
  type MessageChannel,
} from '@/lib/constants/outreach';
import { formatDateTime, fromLocalInput, morningInDays, toLocalInput } from '@/lib/datetime';
import type { Paginated } from '@/types/api';
import type { FollowUpTaskWithLead, Lead, LeadReply, OutreachMessage } from '@/types/database';

type TimelineEntry =
  | { kind: 'sent'; at: string; body: string; id: string }
  | { kind: 'reply'; at: string; body: string; id: string };

/**
 * The conversation with one lead: what was sent, what they answered, and what
 * is planned next. Recording a reply stops the campaign sequence for the lead
 * (the database cancels open follow-ups) and makes "Draft with AI" write a
 * reply instead of another follow-up.
 */
export function ConversationPanel({
  lead,
  refreshKey,
  onReplyRecorded,
}: {
  lead: Lead;
  refreshKey: number;
  onReplyRecorded: () => void;
}) {
  const [sent, setSent] = useState<OutreachMessage[]>([]);
  const [replies, setReplies] = useState<LeadReply[]>([]);
  const [followUps, setFollowUps] = useState<FollowUpTaskWithLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [replyBody, setReplyBody] = useState('');
  const [replyAt, setReplyAt] = useState('');
  const [savingReply, setSavingReply] = useState(false);

  const [planning, setPlanning] = useState(false);
  const [planAt, setPlanAt] = useState(toLocalInput(morningInDays(3)));
  const [planTopic, setPlanTopic] = useState('');
  const [planChannel, setPlanChannel] = useState<MessageChannel>('direct_message');
  const [savingPlan, setSavingPlan] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [messages, replyData, taskData] = await Promise.all([
        apiFetch<Paginated<OutreachMessage>>(
          `/api/messages?leadId=${lead.id}&status=sent&pageSize=100`,
        ),
        apiFetch<{ replies: LeadReply[] }>(`/api/leads/${lead.id}/replies`),
        apiFetch<{ items: FollowUpTaskWithLead[] }>(`/api/followups?leadId=${lead.id}`),
      ]);
      setSent(messages.items);
      setReplies(replyData.replies);
      setFollowUps(taskData.items);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load the conversation.');
    } finally {
      setLoading(false);
    }
  }, [lead.id]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const timeline = useMemo<TimelineEntry[]>(() => {
    const entries: TimelineEntry[] = [
      ...sent.map((m) => ({
        kind: 'sent' as const,
        at: m.sent_at ?? m.created_at,
        body: m.body,
        id: m.id,
      })),
      ...replies.map((r) => ({
        kind: 'reply' as const,
        at: r.received_at,
        body: r.body,
        id: r.id,
      })),
    ];
    return entries.sort((a, b) => a.at.localeCompare(b.at));
  }, [sent, replies]);

  async function saveReply() {
    setSavingReply(true);
    setError(null);
    try {
      await apiFetch(`/api/leads/${lead.id}/replies`, {
        method: 'POST',
        body: JSON.stringify({ body: replyBody, receivedAt: fromLocalInput(replyAt) ?? '' }),
      });
      setReplyBody('');
      setReplyAt('');
      await load();
      onReplyRecorded();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save the reply.');
    } finally {
      setSavingReply(false);
    }
  }

  async function removeReply(id: string) {
    try {
      await apiFetch(`/api/replies/${id}`, { method: 'DELETE' });
      setReplies((prev) => prev.filter((r) => r.id !== id));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not delete the reply.');
    }
  }

  async function planFollowUp() {
    const dueAt = fromLocalInput(planAt);
    if (!dueAt) {
      setError('Choose a date and time for the follow-up.');
      return;
    }
    setSavingPlan(true);
    setError(null);
    try {
      await apiFetch('/api/followups', {
        method: 'POST',
        body: JSON.stringify({ leadId: lead.id, dueAt, topic: planTopic, channel: planChannel }),
      });
      setPlanning(false);
      setPlanTopic('');
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not plan the follow-up.');
    } finally {
      setSavingPlan(false);
    }
  }

  async function skipFollowUp(id: string) {
    try {
      await apiFetch(`/api/followups/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'skip' }),
      });
      setFollowUps((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not skip the follow-up.');
    }
  }

  const blocked = lead.status === 'do_not_contact';

  return (
    <Card>
      <CardHeader
        title="Conversation"
        description="What you sent, what they answered, and the next planned follow-up."
      />
      <CardBody className="space-y-5">
        {error && <Alert tone="error">{error}</Alert>}

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> Loading…
          </div>
        ) : timeline.length === 0 ? (
          <p className="text-sm text-slate-500">
            Nothing sent yet. Messages appear here once you mark them as sent.
          </p>
        ) : (
          <ol className="space-y-3">
            {timeline.map((entry) => (
              <li
                key={`${entry.kind}-${entry.id}`}
                className={
                  entry.kind === 'sent'
                    ? 'ml-6 rounded-md bg-brand-50 px-3 py-2'
                    : 'mr-6 rounded-md bg-slate-100 px-3 py-2'
                }
              >
                <p className="text-xs font-medium text-slate-500">
                  {entry.kind === 'sent' ? 'You' : lead.full_name} · {formatDateTime(entry.at)}
                  {entry.kind === 'reply' && (
                    <button
                      type="button"
                      onClick={() => void removeReply(entry.id)}
                      className="ml-2 text-slate-400 hover:text-rose-600"
                    >
                      Remove
                    </button>
                  )}
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800">{entry.body}</p>
              </li>
            ))}
          </ol>
        )}

        <div className="space-y-2 border-t border-slate-200 pt-4">
          <label htmlFor="reply-body" className="field-label">
            Did they reply? Paste it here
          </label>
          <textarea
            id="reply-body"
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            rows={3}
            className="field-input resize-y"
            placeholder="Their message from LinkedIn"
          />
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label htmlFor="reply-at" className="field-label">
                Received <span className="font-normal text-slate-400">(optional, default now)</span>
              </label>
              <input
                id="reply-at"
                type="datetime-local"
                value={replyAt}
                onChange={(e) => setReplyAt(e.target.value)}
                className="field-input w-auto"
              />
            </div>
            <Button
              onClick={() => void saveReply()}
              loading={savingReply}
              disabled={!replyBody.trim()}
            >
              Save reply
            </Button>
          </div>
          <p className="text-xs text-slate-500">
            Saving a reply stops the planned follow-ups for this lead. Use “Draft with AI” above to
            answer it.
          </p>
        </div>

        <div className="space-y-3 border-t border-slate-200 pt-4">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900">Planned follow-ups</h3>
            {!planning && !blocked && (
              <Button size="sm" variant="secondary" onClick={() => setPlanning(true)}>
                Plan follow-up
              </Button>
            )}
          </div>

          {followUps.length === 0 && !planning && (
            <p className="text-sm text-slate-500">
              None. A campaign with follow-up steps plans them automatically after each message you
              mark as sent.
            </p>
          )}

          {followUps.map((task) => (
            <div
              key={task.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm"
            >
              <Badge>{task.status === 'drafted' ? 'Drafted' : 'Planned'}</Badge>
              <span className="text-slate-700">{formatDateTime(task.due_at)}</span>
              <span className="text-slate-500">{MESSAGE_CHANNEL_LABELS[task.channel]}</span>
              {task.topic && <span className="text-slate-600">· {task.topic}</span>}
              <button
                type="button"
                onClick={() => void skipFollowUp(task.id)}
                className="ml-auto text-xs text-slate-400 hover:text-rose-600"
              >
                Skip
              </button>
            </div>
          ))}

          {planning && (
            <div className="grid gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-3">
              <div>
                <label htmlFor="plan-at" className="field-label">
                  When
                </label>
                <input
                  id="plan-at"
                  type="datetime-local"
                  value={planAt}
                  onChange={(e) => setPlanAt(e.target.value)}
                  className="field-input"
                />
              </div>
              <div>
                <label htmlFor="plan-channel" className="field-label">
                  Type
                </label>
                <select
                  id="plan-channel"
                  value={planChannel}
                  onChange={(e) => setPlanChannel(e.target.value as MessageChannel)}
                  className="field-input"
                >
                  {MESSAGE_CHANNELS.map((c) => (
                    <option key={c} value={c}>
                      {MESSAGE_CHANNEL_LABELS[c]}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="plan-topic" className="field-label">
                  Topic <span className="font-normal text-slate-400">(optional)</span>
                </label>
                <input
                  id="plan-topic"
                  value={planTopic}
                  onChange={(e) => setPlanTopic(e.target.value)}
                  maxLength={500}
                  placeholder="e.g. Share the Nordic case study"
                  className="field-input"
                />
              </div>
              <div className="flex gap-2 sm:col-span-3">
                <Button size="sm" onClick={() => void planFollowUp()} loading={savingPlan}>
                  Save
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPlanning(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </CardBody>
    </Card>
  );
}
