'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { CampaignForm } from '@/components/campaigns/CampaignForm';
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
import { CAMPAIGN_STATUS_LABELS, CAMPAIGN_STATUS_STYLES } from '@/lib/constants/outreach';
import type { Campaign, CampaignSummary } from '@/types/database';

type CampaignWithSummary = Campaign & { summary: CampaignSummary | null };

export function CampaignsManager() {
  const [items, setItems] = useState<CampaignWithSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiFetch<{ items: CampaignWithSummary[] }>('/api/campaigns');
      setItems(data.items);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not load campaigns.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-5">
      {error && <Alert tone="error">{error}</Alert>}

      {creating ? (
        <Card>
          <CardHeader
            title="New campaign"
            description="The sender details and offer are what the AI writes from."
          />
          <CardBody>
            <CampaignForm
              onSaved={() => {
                setCreating(false);
                void load();
              }}
              onCancel={() => setCreating(false)}
            />
          </CardBody>
        </Card>
      ) : (
        <div>
          <Button onClick={() => setCreating(true)}>New campaign</Button>
        </div>
      )}

      <Card>
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
            <Spinner /> Loading campaigns…
          </div>
        ) : items.length === 0 ? (
          <EmptyState
            title="No campaigns yet"
            description="A campaign groups leads and tells the AI who you are and what you offer."
          />
        ) : (
          <ul className="divide-y divide-slate-100">
            {items.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/campaigns/${c.id}`}
                  className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 hover:bg-slate-50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-900">{c.name}</p>
                    <p className="mt-0.5 text-xs text-slate-500">
                      {c.summary?.lead_count ?? 0} leads · {c.summary?.draft_messages ?? 0} drafts ·{' '}
                      {c.summary?.approved_messages ?? 0} approved · {c.summary?.sent_messages ?? 0}{' '}
                      sent
                    </p>
                  </div>
                  <Badge className={CAMPAIGN_STATUS_STYLES[c.status]}>
                    {CAMPAIGN_STATUS_LABELS[c.status]}
                  </Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
