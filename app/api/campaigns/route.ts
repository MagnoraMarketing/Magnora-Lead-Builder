import type { NextRequest } from 'next/server';
import { getAuthedContext } from '@/lib/api/auth';
import { RATE_LIMITS, checkRateLimit } from '@/lib/api/rate-limit';
import {
  fail,
  ok,
  rateLimited,
  serverError,
  unauthorized,
  validationError,
} from '@/lib/api/response';
import { createCampaignSchema } from '@/lib/validation/schemas';
import type { Campaign, CampaignSummary } from '@/types/database';

/** GET /api/campaigns — every campaign the caller owns, with lead and message counts. */
export async function GET() {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;

    const [campaigns, summaries] = await Promise.all([
      supabase
        .from('campaigns')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .returns<Campaign[]>(),
      supabase.rpc('campaign_summaries'),
    ]);

    if (campaigns.error) return serverError('campaigns:list', campaigns.error);
    if (summaries.error) return serverError('campaigns:summaries', summaries.error);

    const byId = new Map<string, CampaignSummary>(
      (summaries.data ?? []).map((s: CampaignSummary) => [s.campaign_id, s]),
    );

    return ok({
      items: (campaigns.data ?? []).map((campaign) => ({
        ...campaign,
        summary: byId.get(campaign.id) ?? null,
      })),
    });
  } catch (error) {
    return serverError('campaigns:list', error);
  }
}

/** POST /api/campaigns */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;

    if (!(await checkRateLimit(user.id, RATE_LIMITS.mutateCampaign))) return rateLimited();

    const parsed = createCampaignSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return validationError(parsed.error);

    const { data, error } = await supabase
      .from('campaigns')
      .insert({ ...parsed.data, user_id: user.id })
      .select()
      .single<Campaign>();

    if (error?.code === '23505') {
      return fail('duplicate_campaign', 'You already have a campaign with that name.', 409);
    }
    if (error) return serverError('campaigns:create', error);

    return ok({ campaign: data }, 201);
  } catch (error) {
    return serverError('campaigns:create', error);
  }
}
