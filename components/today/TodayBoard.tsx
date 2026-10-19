'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { MessageCard } from '@/components/outreach/MessageCard';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Spinner,
} from '@/components/ui';
import { ApiRequestError, apiFetch } from '@/lib/api/client';
import { MESSAGE_CHANNEL_LABELS } from '@/lib/constants/outreach';
import { endOfLocalDay, formatDateTime } from '@/lib/datetime';
import type { OutreachMessage, TodayOverview } from '@/types/database';

/**
 * The daily worklist. The app plans and drafts; the user sends on LinkedIn.
 *
 *   1. Follow-ups due — draft each with AI (or skip it)
 *   2. Ready to send  — approved messages planned for today or unplanned
 *   3. Replies        — leads who wrote back and are waiting for an answer
 */
export function TodayBoard() {
  const [data, setData] = useState<TodayOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafted, setDrafted] = useState<Record<string, OutreachMessage>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await apiFetch<TodayOverview>(`/api/today?until=${encodeURIComponent(endOfLocalDay())}`),
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load today’s work.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function draft(key: string, body: Record<string, unknown>) {
    setBusy(key);
    setError(null);
    try {
      const res = await apiFetch<{ message: OutreachMessage }>('/api/messages/generate', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setDrafted((prev) => ({ ...prev, [key]: res.message }));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not draft the message.');
    } finally {
      setBusy(null);
    }
  }

  async function skip(taskId: string) {
    setBusy(taskId);
    try {
      await apiFetch(`/api/followups/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify({ action: 'skip' }),
      });
      setData(
        (prev) => prev && { ...prev, followUps: prev.followUps.filter((t) => t.id !== taskId) },
      );
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not skip the follow-up.');
    } finally {
      setBusy(null);
    }
  }

  const keepDraft = (key: string) => (updated: OutreachMessage) =>
    setDrafted((prev) => ({ ...prev, [key]: updated }));
  const dropDraft = (key: string) => () =>
    setDrafted((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });

  if (loading && !data) {
    return (
      <Card className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
        <Spinner /> Loading today’s work…
      </Card>
    );
  }

  const followUps = data?.followUps ?? [];
  const readyToSend = data?.readyToSend ?? [];
  const awaiting = data?.awaitingAnswer ?? [];

  return (
    <div className="space-y-5">
      {error && <Alert tone="error">{error}</Alert>}

      <Card>
        <CardHeader
          title={`Follow-ups due (${followUps.length})`}
          description="Planned by your campaign sequences or by you. Draft each one, review it, then send."
        />
        {followUps.length === 0 ? (
          <EmptyState title="No follow-ups due today" />
        ) : (
          <CardBody className="space-y-4">
            {followUps.map((task) => {
              const message = drafted[task.id] ?? task.message;
              return (
                <div key={task.id} className="space-y-2 rounded-md border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {task.lead ? (
                      <Link
                        href={`/leads/${task.lead.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {task.lead.full_name}
                      </Link>
                    ) : (
                      <span className="text-slate-400">Deleted lead</span>
                    )}
                    <span className="text-sm text-slate-500">{task.lead?.company_name ?? ''}</span>
                    <Badge>
                      {task.step_number ? `Follow-up ${task.step_number - 1}` : 'Planned follow-up'}
                    </Badge>
                    <span className="text-xs text-slate-500">
                      Due {formatDateTime(task.due_at)} · {MESSAGE_CHANNEL_LABELS[task.channel]}
                    </span>
                  </div>
                  {task.topic && <p className="text-sm text-slate-600">Topic: {task.topic}</p>}
                  {message ? (
                    <MessageCard
                      message={message}
                      onChange={keepDraft(task.id)}
                      onDelete={dropDraft(task.id)}
                    />
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        loading={busy === task.id}
                        onClick={() =>
                          void draft(task.id, { leadId: task.lead_id, taskId: task.id })
                        }
                      >
                        Draft with AI
                      </Button>
                      {task.lead && (
                        <Link href={`/leads/${task.lead.id}`}>
                          <Button size="sm" variant="secondary">
                            Write it myself
                          </Button>
                        </Link>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy === task.id}
                        onClick={() => void skip(task.id)}
                      >
                        Skip
                      </Button>
                    </div>
                  )}
                </div>
              );
            })}
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHeader
          title={`Waiting for your answer (${awaiting.length})`}
          description="These leads replied after your last message."
        />
        {awaiting.length === 0 ? (
          <EmptyState title="No unanswered replies" />
        ) : (
          <CardBody className="space-y-4">
            {awaiting.map((reply) => {
              const key = `reply:${reply.id}`;
              const message = drafted[key];
              return (
                <div key={reply.id} className="space-y-2 rounded-md border border-slate-200 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    {reply.lead && (
                      <Link
                        href={`/leads/${reply.lead.id}`}
                        className="font-medium text-brand-700 hover:underline"
                      >
                        {reply.lead.full_name}
                      </Link>
                    )}
                    <span className="text-xs text-slate-500">
                      replied {formatDateTime(reply.received_at)}
                    </span>
                  </div>
                  <blockquote className="whitespace-pre-wrap border-l-2 border-slate-300 pl-3 text-sm text-slate-700">
                    {reply.body}
                  </blockquote>
                  {message ? (
                    <MessageCard
                      message={message}
                      onChange={keepDraft(key)}
                      onDelete={dropDraft(key)}
                    />
                  ) : (
                    <Button
                      size="sm"
                      loading={busy === key}
                      onClick={() =>
                        void draft(key, {
                          leadId: reply.lead_id,
                          kind: 'reply',
                          channel: 'direct_message',
                        })
                      }
                    >
                      Draft reply with AI
                    </Button>
                  )}
                </div>
              );
            })}
          </CardBody>
        )}
      </Card>

      <Card>
        <CardHeader
          title={`Ready to send (${readyToSend.length})`}
          description="Approved, and planned for today or not planned. Copy, send on LinkedIn, then mark as sent."
        />
        {readyToSend.length === 0 ? (
          <EmptyState title="Nothing approved and waiting" />
        ) : (
          <CardBody className="space-y-3">
            {readyToSend.map((m) => (
              <MessageCard
                key={m.id}
                message={m}
                onChange={(updated) =>
                  setData(
                    (prev) =>
                      prev && {
                        ...prev,
                        readyToSend: prev.readyToSend.map((x) =>
                          x.id === updated.id ? { ...x, ...updated } : x,
                        ),
                      },
                  )
                }
                onDelete={(id) =>
                  setData(
                    (prev) =>
                      prev && { ...prev, readyToSend: prev.readyToSend.filter((x) => x.id !== id) },
                  )
                }
              />
            ))}
          </CardBody>
        )}
      </Card>
    </div>
  );
}
