'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCampaigns } from '@/components/campaigns/useCampaigns';
import { MessageCard } from '@/components/outreach/MessageCard';
import { Alert, Button, Card, EmptyState, Spinner, cx } from '@/components/ui';
import { ApiRequestError, apiFetch } from '@/lib/api/client';
import { MESSAGE_STATUSES, MESSAGE_STATUS_LABELS, type MessageStatus } from '@/lib/constants/outreach';
import type { Paginated } from '@/types/api';
import type { OutreachMessage, OutreachMessageWithLead } from '@/types/database';

const PAGE_SIZE = 25;

const EMPTY_HINT: Record<MessageStatus | 'all', string> = {
  all: 'Open a lead and draft a message to get started.',
  draft: 'No drafts waiting for review.',
  approved: 'Nothing approved and waiting to be sent.',
  sent: 'No messages have been marked as sent yet.',
  archived: 'Nothing archived.',
};

/** The review queue: drafts to approve, approved messages to send, and the sent record. */
export function MessagesQueue() {
  const searchParams = useSearchParams();
  const campaigns = useCampaigns();

  const [status, setStatus] = useState<MessageStatus | 'all'>(() => {
    const param = searchParams.get('status');
    return param === 'all' || MESSAGE_STATUSES.some((s) => s === param)
      ? (param as MessageStatus | 'all')
      : 'draft';
  });
  const [campaignId, setCampaignId] = useState(searchParams.get('campaignId') ?? '');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paginated<OutreachMessageWithLead> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const queryString = useMemo(() => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (status !== 'all') params.set('status', status);
    if (campaignId) params.set('campaignId', campaignId);
    return params.toString();
  }, [page, status, campaignId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiFetch<Paginated<OutreachMessageWithLead>>(`/api/messages?${queryString}`));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load messages.');
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Keep the lead join, which the PATCH response does not include. A message
  // that no longer matches the status tab stays visible until the next load,
  // so it does not jump away from under the cursor.
  function replace(updated: OutreachMessage) {
    setData((prev) =>
      prev && {
        ...prev,
        items: prev.items.map((m) => (m.id === updated.id ? { ...m, ...updated } : m)),
      },
    );
  }

  function drop(id: string) {
    setData((prev) =>
      prev && { ...prev, items: prev.items.filter((m) => m.id !== id), total: prev.total - 1 },
    );
  }

  const tabs: (MessageStatus | 'all')[] = [...MESSAGE_STATUSES, 'all'];

  return (
    <div className="space-y-4">
      {error && <Alert tone="error">{error}</Alert>}

      <Card className="flex flex-wrap items-end gap-3 p-4">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="Message status">
          {tabs.map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={status === tab}
              onClick={() => {
                setStatus(tab);
                setPage(1);
              }}
              className={cx(
                'rounded-md px-3 py-1.5 text-sm font-medium',
                status === tab ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100',
              )}
            >
              {tab === 'all' ? 'All' : MESSAGE_STATUS_LABELS[tab]}
            </button>
          ))}
        </div>
        <div className="ml-auto min-w-[200px]">
          <label htmlFor="queue-campaign" className="field-label">
            Campaign
          </label>
          <select
            id="queue-campaign"
            value={campaignId}
            onChange={(e) => {
              setCampaignId(e.target.value);
              setPage(1);
            }}
            className="field-input"
          >
            <option value="">All campaigns</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      </Card>

      {loading && items.length === 0 ? (
        <Card className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
          <Spinner /> Loading messages…
        </Card>
      ) : items.length === 0 ? (
        <Card>
          <EmptyState
            title="No messages here"
            description={EMPTY_HINT[status]}
            action={
              <Link href="/leads">
                <Button variant="secondary">Go to leads</Button>
              </Link>
            }
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {items.map((m) => (
            <MessageCard key={m.id} message={m} onChange={replace} onDelete={drop} />
          ))}
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between text-sm">
          <p className="text-slate-500">
            {total.toLocaleString('en-US')} messages · page {page} of {totalPages}
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || loading}
            >
              Previous
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages || loading}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
