'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { MessageCard } from '@/components/outreach/MessageCard';
import { Modal } from '@/components/ui/Modal';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, Spinner, cx } from '@/components/ui';
import { ApiRequestError, apiFetch } from '@/lib/api/client';
import {
  MESSAGE_STATUS_LABELS,
  MESSAGE_STATUS_STYLES,
  type MessageStatus,
} from '@/lib/constants/outreach';
import type { Paginated } from '@/types/api';
import type { OutreachMessage, OutreachMessageWithLead } from '@/types/database';

const PAGE_SIZE = 20;

const FILTERS: { value: MessageStatus | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Draft' },
  { value: 'approved', label: 'Approved' },
  { value: 'sent', label: 'Sent' },
];

/**
 * The Lead Builder's table: one row per message, newest first, with the
 * Draft → Approved → Sent status, a context-aware action button, and an
 * expandable preview where the text can be edited, copied or archived.
 */
export function LeadsMessagesTable({ reloadKey }: { reloadKey: number }) {
  const [status, setStatus] = useState<MessageStatus | ''>('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paginated<OutreachMessageWithLead> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmSent, setConfirmSent] = useState<OutreachMessageWithLead | null>(null);

  const queryString = useMemo(() => {
    const params = new URLSearchParams({
      sort: 'created',
      page: String(page),
      pageSize: String(PAGE_SIZE),
    });
    if (status) params.set('status', status);
    return params.toString();
  }, [status, page]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiFetch<Paginated<OutreachMessageWithLead>>(`/api/messages?${queryString}`));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load your leads.');
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

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

  async function act(message: OutreachMessageWithLead, action: 'approve' | 'mark_sent') {
    setBusyId(message.id);
    setError(null);
    try {
      const res = await apiFetch<{ message: OutreachMessage }>(`/api/messages/${message.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ action }),
      });
      replace(res.message);
      return true;
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not update the message.');
      return false;
    } finally {
      setBusyId(null);
    }
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <Card>
      <CardHeader
        title="Leads & messages"
        description="Newest first. Approve a draft, send it on LinkedIn, then mark it as sent."
        action={
          <div className="flex flex-wrap gap-1" role="tablist" aria-label="Filter by status">
            {FILTERS.map((f) => (
              <button
                key={f.label}
                type="button"
                role="tab"
                aria-selected={status === f.value}
                onClick={() => {
                  setStatus(f.value);
                  setPage(1);
                }}
                className={cx(
                  'rounded-md px-2.5 py-1 text-xs font-medium',
                  status === f.value
                    ? 'bg-brand-50 text-brand-700'
                    : 'text-slate-600 hover:bg-slate-100',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
        }
      />

      {error && (
        <div className="px-5 pt-4">
          <Alert tone="error">{error}</Alert>
        </div>
      )}

      {loading && items.length === 0 ? (
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500">
          <Spinner /> Loading…
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          title={status ? 'Nothing with this status' : 'No leads yet'}
          description={
            status
              ? 'Try another filter.'
              : 'Fill in the form above and generate your first message.'
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="hidden px-4 py-2.5 font-medium sm:table-cell">Role</th>
                <th className="hidden px-4 py-2.5 font-medium md:table-cell">Company</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="hidden px-4 py-2.5 font-medium lg:table-cell">Created</th>
                <th className="px-4 py-2.5 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((m) => {
                const isOpen = expanded === m.id;
                return (
                  <Fragment key={m.id}>
                    <tr className={cx('align-top', isOpen && 'bg-slate-50')}>
                      <td className="px-4 py-3">
                        {m.lead ? (
                          <Link
                            href={`/leads/${m.lead.id}`}
                            className="font-medium text-brand-700 hover:underline"
                          >
                            {m.lead.full_name}
                          </Link>
                        ) : (
                          <span className="text-slate-400">Deleted lead</span>
                        )}
                        <p className="text-xs text-slate-500 sm:hidden">
                          {[m.lead?.job_title, m.lead?.company_name].filter(Boolean).join(' · ')}
                        </p>
                      </td>
                      <td className="hidden max-w-[180px] truncate px-4 py-3 text-slate-600 sm:table-cell">
                        {m.lead?.job_title ?? '—'}
                      </td>
                      <td className="hidden max-w-[180px] truncate px-4 py-3 text-slate-600 md:table-cell">
                        {m.lead?.company_name ?? '—'}
                      </td>
                      <td className="px-4 py-3">
                        <Badge className={MESSAGE_STATUS_STYLES[m.status]}>
                          {MESSAGE_STATUS_LABELS[m.status]}
                        </Badge>
                      </td>
                      <td className="hidden whitespace-nowrap px-4 py-3 text-slate-500 lg:table-cell">
                        {new Date(m.created_at).toLocaleDateString('en-GB')}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap justify-end gap-2">
                          {m.status === 'draft' && (
                            <Button
                              size="sm"
                              loading={busyId === m.id}
                              onClick={() => void act(m, 'approve')}
                            >
                              Approve
                            </Button>
                          )}
                          {m.status === 'approved' && (
                            <Button size="sm" onClick={() => setConfirmSent(m)}>
                              Mark as sent
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="secondary"
                            aria-expanded={isOpen}
                            onClick={() => setExpanded(isOpen ? null : m.id)}
                          >
                            {isOpen ? 'Hide' : 'Message'}
                          </Button>
                        </div>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-slate-50">
                        <td colSpan={6} className="px-4 pb-4">
                          <MessageCard message={m} onChange={replace} onDelete={drop} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between border-t border-slate-200 px-4 py-3 text-sm">
          <p className="text-slate-500">
            Page {page} of {totalPages}
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

      <Modal
        open={confirmSent !== null}
        onClose={() => setConfirmSent(null)}
        title="Mark as sent"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmSent(null)}>
              Not yet
            </Button>
            <Button
              loading={confirmSent !== null && busyId === confirmSent.id}
              onClick={async () => {
                if (confirmSent && (await act(confirmSent, 'mark_sent'))) setConfirmSent(null);
              }}
            >
              I have sent it
            </Button>
          </>
        }
      >
        Only confirm once you have actually sent this message to{' '}
        {confirmSent?.lead?.full_name ?? 'the lead'} on LinkedIn. It is then locked as a record.
      </Modal>
    </Card>
  );
}
