import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { CampaignDetail } from '@/components/campaigns/CampaignDetail';
import { createClient } from '@/lib/supabase/server';
import type { Campaign, CampaignSummary } from '@/types/database';

export const metadata: Metadata = { title: 'Campaign' };
export const dynamic = 'force-dynamic';

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const [{ data: campaign }, { data: summaries }] = await Promise.all([
    supabase
      .from('campaigns')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle<Campaign>(),
    supabase.rpc('campaign_summaries'),
  ]);

  if (!campaign) notFound();

  const summary =
    (summaries ?? []).find((s: CampaignSummary) => s.campaign_id === campaign.id) ?? null;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <Link href="/campaigns" className="text-sm text-slate-500 hover:text-slate-700">
        ← Back to campaigns
      </Link>
      <h1 className="text-xl font-semibold text-slate-900">{campaign.name}</h1>
      <CampaignDetail initialCampaign={campaign} summary={summary} />
    </div>
  );
}
