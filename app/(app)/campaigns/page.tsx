import type { Metadata } from 'next';
import { CampaignsManager } from '@/components/campaigns/CampaignsManager';

export const metadata: Metadata = { title: 'Campaigns' };

export default function CampaignsPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-slate-900">Campaigns</h1>
        <p className="mt-1 text-sm text-slate-500">
          Group leads and give the AI the context it writes your LinkedIn messages from.
        </p>
      </header>
      <CampaignsManager />
    </div>
  );
}
