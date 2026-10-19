'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CampaignForm } from '@/components/campaigns/CampaignForm';
import { Modal } from '@/components/ui/Modal';
import { Alert, Button, Card, CardBody, CardHeader, StatCard } from '@/components/ui';
import { ApiRequestError, apiFetch } from '@/lib/api/client';
import type { Campaign, CampaignSummary } from '@/types/database';

export function CampaignDetail({
  initialCampaign,
  summary,
}: {
  initialCampaign: Campaign;
  summary: CampaignSummary | null;
}) {
  const router = useRouter();
  const [campaign, setCampaign] = useState(initialCampaign);
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function remove() {
    setDeleting(true);
    try {
      await apiFetch(`/api/campaigns/${campaign.id}`, { method: 'DELETE' });
      router.push('/campaigns');
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not delete the campaign.');
      setDeleting(false);
      setConfirmDelete(false);
    }
  }

  return (
    <div className="space-y-5">
      {error && <Alert tone="error">{error}</Alert>}

      <div className="grid gap-4 sm:grid-cols-4">
        <StatCard label="Leads" value={summary?.lead_count ?? 0} />
        <StatCard label="Drafts" value={summary?.draft_messages ?? 0} />
        <StatCard label="Approved" value={summary?.approved_messages ?? 0} />
        <StatCard label="Sent" value={summary?.sent_messages ?? 0} />
      </div>

      <div className="flex flex-wrap gap-2">
        <Link href={`/leads?campaignId=${campaign.id}`}>
          <Button variant="secondary">View leads</Button>
        </Link>
        <Link href={`/messages?campaignId=${campaign.id}`}>
          <Button variant="secondary">View messages</Button>
        </Link>
      </div>

      <Card>
        <CardHeader
          title="Campaign details"
          action={
            <Button variant="danger" size="sm" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
          }
        />
        <CardBody>
          {saved && (
            <div className="mb-4">
              <Alert tone="success">Saved.</Alert>
            </div>
          )}
          <CampaignForm
            campaign={campaign}
            onSaved={(updated) => {
              setCampaign(updated);
              setSaved(true);
              router.refresh();
            }}
          />
        </CardBody>
      </Card>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete campaign"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={() => void remove()} loading={deleting}>
              Delete
            </Button>
          </>
        }
      >
        Delete {campaign.name}? Its leads and messages are kept and simply lose the campaign.
      </Modal>
    </div>
  );
}
