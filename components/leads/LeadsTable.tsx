'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCampaigns } from '@/components/campaigns/useCampaigns';
import { ImportLeadsModal } from '@/components/leads/ImportLeadsModal';
import { Modal } from '@/components/ui/Modal';
import { Alert, Badge, Button, Card, EmptyState, Spinner, cx } from '@/components/ui';
import { ApiRequestError, apiFetch } from '@/lib/api/client';
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_STYLES,
  type LeadStatus,
} from '@/lib/constants/leads';
import {
  MESSAGE_CHANNELS,
  MESSAGE_CHANNEL_LABELS,
  type MessageChannel,
} from '@/lib/constants/outreach';
import { LEAD_SORT_COLUMNS } from '@/lib/leads/query';
import type { Paginated } from '@/types/api';
import type { Lead } from '@/types/database';

type SortColumn = (typeof LEAD_SORT_COLUMNS)[number];

const PAGE_SIZE = 50;

/** Errors that will fail the same way for every remaining lead, so a bulk run stops. */
const STOP_BULK = new Set([
  'cvr_not_configured',
  'cvr_auth_failed',
  'ai_not_configured',
  'ai_auth_failed',
  'ai_request_rejected',
  'rate_limited',
  'unauthorized',
]);

type BulkNote = { tone: 'success' | 'info' | 'error'; text: string; drafts?: boolean };

export function LeadsTable() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const jobIdFilter = searchParams.get('jobId') ?? undefined;
  const campaigns = useCampaigns();

  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [status, setStatus] = useState<LeadStatus | ''>('');
  const [campaignId, setCampaignId] = useState(searchParams.get('campaignId') ?? '');
  const [importOpen, setImportOpen] = useState(false);
  const [sort, setSort] = useState<SortColumn>('created_at');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);

  const [data, setData] = useState<Paginated<Lead> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [progress, setProgress] = useState<{ label: string; done: number; total: number } | null>(null);
  const [bulkNote, setBulkNote] = useState<BulkNote | null>(null);
  const [draftChannel, setDraftChannel] = useState<MessageChannel>('connection_request');
  const preselectedJob = useRef<string | null>(null);

  // Debounce the search box so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [search]);

  const queryString = useMemo(() => {
    const params = new URLSearchParams({
      page: String(page),
      pageSize: String(PAGE_SIZE),
      sort,
      direction,
    });
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (status) params.set('status', status);
    if (jobIdFilter) params.set('jobId', jobIdFilter);
    if (campaignId) params.set('campaignId', campaignId);
    return params.toString();
  }, [page, sort, direction, debouncedSearch, status, jobIdFilter, campaignId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await apiFetch<Paginated<Lead>>(`/api/leads?${queryString}`));
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load leads.');
    } finally {
      setLoading(false);
    }
  }, [queryString]);

  useEffect(() => {
    void load();
  }, [load]);

  // Leads opened from a search start fully selected, ready for CVR and drafts.
  useEffect(() => {
    if (!jobIdFilter || !data || preselectedJob.current === jobIdFilter) return;
    preselectedJob.current = jobIdFilter;
    setSelected(new Set(data.items.map((l) => l.id)));
  }, [jobIdFilter, data]);

  /**
   * Runs one request per selected lead, one at a time, so each lead gets the
   * same checks as the single-lead action and the server never sees a burst.
   * Stops early on an error that would repeat for every lead.
   */
  async function runForSelected(
    label: string,
    each: (lead: Lead) => Promise<'ok' | 'skipped' | 'none'>,
  ): Promise<{ ok: number; skipped: number; none: number; failed: string[]; stopped: string | null }> {
    const leads = items.filter((l) => selected.has(l.id));
    const tally = { ok: 0, skipped: 0, none: 0, failed: [] as string[], stopped: null as string | null };
    setBusy(true);
    setBulkNote(null);
    setProgress({ label, done: 0, total: leads.length });
    for (const [index, lead] of leads.entries()) {
      try {
        tally[await each(lead)] += 1;
      } catch (err) {
        if (err instanceof ApiRequestError && STOP_BULK.has(err.code)) {
          tally.stopped = err.message;
          break;
        }
        if (err instanceof ApiRequestError && (err.code === 'do_not_contact' || err.code === 'reklamebeskyttet')) {
          tally.skipped += 1;
        } else {
          tally.failed.push(lead.full_name);
        }
      }
      setProgress({ label, done: index + 1, total: leads.length });
    }
    setProgress(null);
    setBusy(false);
    return tally;
  }

  async function bulkCvr() {
    const result = await runForSelected('Fetching from CVR', async (lead) => {
      const res = await apiFetch<{ outcome: 'found' | 'choose' | 'not_found'; lead?: Lead }>(
        `/api/leads/${lead.id}/cvr`,
        { method: 'POST', body: '{}' },
      );
      if (res.outcome === 'found' && res.lead) {
        const updated = res.lead;
        setData((prev) => prev && { ...prev, items: prev.items.map((l) => (l.id === updated.id ? updated : l)) });
        return 'ok';
      }
      return res.outcome === 'choose' ? 'skipped' : 'none';
    });
    const parts = [`${result.ok} matched in CVR.`];
    if (result.skipped) parts.push(`${result.skipped} need you to pick the company (open the lead) or are reklamebeskyttet / do not contact.`);
    if (result.none) parts.push(`${result.none} not found.`);
    if (result.failed.length) parts.push(`Failed: ${result.failed.join(', ')}.`);
    if (result.stopped) parts.push(`Stopped: ${result.stopped}`);
    setBulkNote({ tone: result.stopped ? 'error' : 'success', text: parts.join(' ') });
  }

  async function bulkDraft() {
    const result = await runForSelected('Drafting messages', async (lead) => {
      await apiFetch('/api/messages/generate', {
        method: 'POST',
        body: JSON.stringify({ leadId: lead.id, channel: draftChannel }),
      });
      return 'ok';
    });
    const parts = [`${result.ok} draft${result.ok === 1 ? '' : 's'} saved.`];
    if (result.skipped) parts.push(`${result.skipped} skipped (do not contact).`);
    if (result.failed.length) parts.push(`Failed: ${result.failed.join(', ')}.`);
    if (result.stopped) parts.push(`Stopped: ${result.stopped}`);
    setBulkNote({ tone: result.stopped ? 'error' : 'success', text: parts.join(' '), drafts: result.ok > 0 });
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const allSelected = items.length > 0 && items.every((l) => selected.has(l.id));

  function toggleSort(column: SortColumn) {
    if (sort === column) {
      setDirection(direction === 'asc' ? 'desc' : 'asc');
    } else {
      setSort(column);
      setDirection('asc');
    }
    setPage(1);
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(items.map((l) => l.id)));
  }

  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  async function bulkStatus(newStatus: LeadStatus) {
    setBusy(true);
    try {
      await apiFetch('/api/leads', {
        method: 'POST',
        body: JSON.stringify({
          action: 'set_status',
          leadIds: [...selected],
          status: newStatus,
        }),
      });
      setSelected(new Set());
      await load();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not update those leads.');
    } finally {
      setBusy(false);
    }
  }

  async function bulkCampaign(newCampaignId: string | null) {
    setBusy(true);
    try {
      await apiFetch('/api/leads', {
        method: 'POST',
        body: JSON.stringify({
          action: 'set_campaign',
          leadIds: [...selected],
          campaignId: newCampaignId,
        }),
      });
      setSelected(new Set());
      await load();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not update those leads.');
    } finally {
      setBusy(false);
    }
  }

  async function bulkDelete() {
    setBusy(true);
    try {
      await apiFetch('/api/leads', {
        method: 'POST',
        body: JSON.stringify({ action: 'delete', leadIds: [...selected] }),
      });
      setSelected(new Set());
      setConfirmDelete(false);
      await load();
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not delete those leads.');
    } finally {
      setBusy(false);
    }
  }

  async function exportCsv(mode: 'all' | 'selected' | 'filtered') {
    setBusy(true);
    try {
      const body =
        mode === 'selected'
          ? { mode, leadIds: [...selected] }
          : mode === 'filtered'
            ? {
                mode,
                filters: {
                  ...(debouncedSearch ? { search: debouncedSearch } : {}),
                  ...(status ? { status } : {}),
                  ...(jobIdFilter ? { jobId: jobIdFilter } : {}),
                  ...(campaignId ? { campaignId } : {}),
                },
              }
            : { mode };

      const response = await fetch('/api/leads/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        setError('Could not build the export. Please try again.');
        return;
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'leads.csv';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {error && <Alert tone="error">{error}</Alert>}

      {jobIdFilter && (
        <Alert tone="info">
          Showing leads from one search only.{' '}
          <Link href="/leads" className="font-medium underline">
            Show all leads
          </Link>
        </Alert>
      )}

      <Card className="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <label htmlFor="lead-search" className="field-label">
              Search
            </label>
            <input
              id="lead-search"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Name, company, title or email"
              className="field-input"
            />
          </div>

          <div>
            <label htmlFor="lead-status" className="field-label">
              Status
            </label>
            <select
              id="lead-status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as LeadStatus | '');
                setPage(1);
              }}
              className="field-input"
            >
              <option value="">All statuses</option>
              {LEAD_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {LEAD_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="lead-campaign-filter" className="field-label">
              Campaign
            </label>
            <select
              id="lead-campaign-filter"
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

          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setImportOpen(true)} disabled={busy}>
              Import CSV
            </Button>
            <Button variant="secondary" onClick={() => exportCsv('filtered')} disabled={busy}>
              Export filtered
            </Button>
            <Button variant="secondary" onClick={() => exportCsv('all')} disabled={busy}>
              Export all
            </Button>
          </div>
        </div>
      </Card>

      {selected.size > 0 && (
        <Card className="flex flex-wrap items-center gap-3 border-brand-200 bg-brand-50 p-3">
          <span className="text-sm font-medium text-brand-900">
            {selected.size} selected
          </span>
          <select
            aria-label="Change status of selected leads"
            className="field-input w-auto py-1.5 text-xs"
            value=""
            disabled={busy}
            onChange={(e) => {
              if (e.target.value) void bulkStatus(e.target.value as LeadStatus);
            }}
          >
            <option value="">Change status…</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {LEAD_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <select
            aria-label="Assign selected leads to a campaign"
            className="field-input w-auto py-1.5 text-xs"
            value=""
            disabled={busy}
            onChange={(e) => {
              const value = e.target.value;
              if (value) void bulkCampaign(value === 'none' ? null : value);
            }}
          >
            <option value="">Assign campaign…</option>
            <option value="none">Remove from campaign</option>
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <Button size="sm" variant="secondary" onClick={() => void bulkCvr()} disabled={busy}>
            Fetch from CVR
          </Button>
          <span className="flex items-center gap-1">
            <select
              aria-label="Message type for drafts"
              className="field-input w-auto py-1.5 text-xs"
              value={draftChannel}
              disabled={busy}
              onChange={(e) => setDraftChannel(e.target.value as MessageChannel)}
            >
              {MESSAGE_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {MESSAGE_CHANNEL_LABELS[c]}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={() => void bulkDraft()} disabled={busy}>
              Draft with AI
            </Button>
          </span>
          <Button size="sm" variant="secondary" onClick={() => exportCsv('selected')} disabled={busy}>
            Export selected
          </Button>
          <Button size="sm" variant="danger" onClick={() => setConfirmDelete(true)} disabled={busy}>
            Delete
          </Button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="ml-auto text-xs text-brand-700 hover:underline"
          >
            Clear selection
          </button>
        </Card>
      )}

      {progress && (
        <Alert tone="info">
          {progress.label}… {progress.done} of {progress.total}
        </Alert>
      )}
      {bulkNote && (
        <Alert tone={bulkNote.tone}>
          {bulkNote.text}
          {bulkNote.drafts && (
            <>
              {' '}
              <Link href="/messages" className="font-medium underline">
                Review and approve them in Messages
              </Link>
              , then copy each one, send it on LinkedIn and mark it as sent.
            </>
          )}
        </Alert>
      )}

      <Card>
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
            <Spinner /> Loading leads…
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title="No leads found"
            description={
              debouncedSearch || status || campaignId
                ? 'Nothing matches those filters. Try clearing them.'
                : 'Run a search or import a CSV to start collecting leads.'
            }
            action={
              !debouncedSearch && !status && !campaignId ? (
                <Link href="/search">
                  <Button>Start a search</Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <>
            {/* Desktop / tablet: full table */}
            <div className="hidden overflow-x-auto md:block">
              <table className="w-full min-w-[900px] text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="w-10 px-4 py-2.5">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleAll}
                        aria-label="Select all leads on this page"
                        className="h-4 w-4 rounded border-slate-300"
                      />
                    </th>
                    <SortHeader
                      label="Company"
                      column="company_name"
                      {...{ sort, direction, toggleSort }}
                    />
                    <th className="px-4 py-2.5 font-medium">Industry</th>
                    <SortHeader label="Contact person" column="full_name" {...{ sort, direction, toggleSort }} />
                    <SortHeader label="Title" column="job_title" {...{ sort, direction, toggleSort }} />
                    <th className="px-4 py-2.5 font-medium">Contact details</th>
                    <SortHeader label="Status" column="status" {...{ sort, direction, toggleSort }} />
                    <SortHeader
                      label="Created"
                      column="created_at"
                      {...{ sort, direction, toggleSort }}
                    />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((lead) => (
                    <tr key={lead.id} className={cx('hover:bg-slate-50', selected.has(lead.id) && 'bg-brand-50/50')}>
                      <td className="px-4 py-2.5">
                        <input
                          type="checkbox"
                          checked={selected.has(lead.id)}
                          onChange={() => toggleOne(lead.id)}
                          aria-label={`Select ${lead.full_name}`}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                      </td>
                      <td className="max-w-[200px] px-4 py-2.5 text-slate-700">
                        <p className="truncate">{lead.company_name ?? '—'}</p>
                        {lead.cvr_number && (
                          <p className="text-xs text-slate-400">CVR {lead.cvr_number}</p>
                        )}
                      </td>
                      <td className="max-w-[180px] truncate px-4 py-2.5 text-slate-600">
                        {lead.industry ?? <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/leads/${lead.id}`}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          {lead.full_name}
                        </Link>
                        {lead.linkedin_url && (
                          <a
                            href={lead.linkedin_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="ml-2 text-xs text-brand-600 hover:underline"
                          >
                            LinkedIn
                          </a>
                        )}
                      </td>
                      <td className="max-w-[200px] truncate px-4 py-2.5 text-slate-600">
                        {lead.job_title ?? '—'}
                      </td>
                      <td className="max-w-[220px] px-4 py-2.5 text-xs text-slate-600">
                        <ContactDetails lead={lead} />
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge className={LEAD_STATUS_STYLES[lead.status]}>
                          {LEAD_STATUS_LABELS[lead.status]}
                        </Badge>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-500">
                        {new Date(lead.created_at).toLocaleDateString('en-GB')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile: cards, because a 10-column table is unusable at this width */}
            <ul className="divide-y divide-slate-100 md:hidden">
              {items.map((lead) => (
                <li key={lead.id} className="flex gap-3 px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selected.has(lead.id)}
                    onChange={() => toggleOne(lead.id)}
                    aria-label={`Select ${lead.full_name}`}
                    className="mt-1 h-4 w-4 shrink-0 rounded border-slate-300"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={`/leads/${lead.id}`}
                        className="truncate font-medium text-brand-700"
                      >
                        {lead.full_name}
                      </Link>
                      <Badge className={LEAD_STATUS_STYLES[lead.status]}>
                        {LEAD_STATUS_LABELS[lead.status]}
                      </Badge>
                    </div>
                    <p className="truncate text-sm text-slate-600">{lead.job_title ?? '—'}</p>
                    <p className="truncate text-sm text-slate-500">
                      {[lead.company_name, lead.industry].filter(Boolean).join(' · ') || '—'}
                    </p>
                    <div className="mt-1 text-xs text-slate-500">
                      <ContactDetails lead={lead} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm">
              <p className="text-slate-500">
                {total.toLocaleString('en-US')} lead{total === 1 ? '' : 's'} · page {page} of{' '}
                {totalPages}
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
          </>
        )}
      </Card>

      <ImportLeadsModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => void load()}
        campaigns={campaigns}
      />

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete leads"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={bulkDelete} loading={busy}>
              Delete {selected.size}
            </Button>
          </>
        }
      >
        Deleting {selected.size} lead{selected.size === 1 ? '' : 's'} cannot be undone. A future
        search may find the same people again and re-add them.
      </Modal>
    </div>
  );
}

function SortHeader({
  label,
  column,
  sort,
  direction,
  toggleSort,
}: {
  label: string;
  column: SortColumn;
  sort: SortColumn;
  direction: 'asc' | 'desc';
  toggleSort: (column: SortColumn) => void;
}) {
  const active = sort === column;
  return (
    <th
      className="px-4 py-2.5 font-medium"
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <button
        type="button"
        onClick={() => toggleSort(column)}
        className="inline-flex items-center gap-1 uppercase tracking-wide hover:text-slate-900"
      >
        {label}
        <span aria-hidden="true" className={active ? 'text-slate-900' : 'text-slate-300'}>
          {active && direction === 'asc' ? '▲' : '▼'}
        </span>
      </button>
    </th>
  );
}

/** Personal details first, then the company's own (from CVR), labelled so they are not confused. */
function ContactDetails({ lead }: { lead: Lead }) {
  const rows = [
    lead.email,
    lead.mobile_phone ?? lead.phone,
    lead.company_email ? `${lead.company_email} (company)` : null,
    lead.company_phone ? `${lead.company_phone} (company)` : null,
  ].filter((v): v is string => Boolean(v));
  if (rows.length === 0) return <span className="text-slate-400">—</span>;
  return (
    <>
      {rows.map((row) => (
        <p key={row} className="truncate">
          {row}
        </p>
      ))}
    </>
  );
}
