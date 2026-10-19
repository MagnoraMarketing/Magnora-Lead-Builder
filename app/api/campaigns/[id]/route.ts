import { getAuthedContext } from '@/lib/api/auth';
import { RATE_LIMITS, checkRateLimit } from '@/lib/api/rate-limit';
import {
  fail,
  notFound,
  ok,
  rateLimited,
  serverError,
  unauthorized,
  validationError,
} from '@/lib/api/response';
import { updateCampaignSchema } from '@/lib/validation/schemas';
import type { Campaign } from '@/types/database';

type Params = { params: Promise<{ id: string }> };

/** GET /api/campaigns/[id] */
export async function GET(_request: Request, { params }: Params) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;
    const { id } = await params;

    const { data, error } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle<Campaign>();

    if (error) return serverError('campaigns:get', error);
    if (!data) return notFound('Campaign');

    return ok({ campaign: data });
  } catch (error) {
    return serverError('campaigns:get', error);
  }
}

/** PATCH /api/campaigns/[id] */
export async function PATCH(request: Request, { params }: Params) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;
    const { id } = await params;

    if (!(await checkRateLimit(user.id, RATE_LIMITS.mutateCampaign))) return rateLimited();

    const parsed = updateCampaignSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return validationError(parsed.error);

    const { data, error } = await supabase
      .from('campaigns')
      .update(parsed.data)
      .eq('id', id)
      .eq('user_id', user.id)
      .select()
      .maybeSingle<Campaign>();

    if (error?.code === '23505') {
      return fail('duplicate_campaign', 'You already have a campaign with that name.', 409);
    }
    if (error) return serverError('campaigns:patch', error);
    if (!data) return notFound('Campaign');

    return ok({ campaign: data });
  } catch (error) {
    return serverError('campaigns:patch', error);
  }
}

/**
 * DELETE /api/campaigns/[id]
 *
 * Leads and messages survive: their campaign_id is cleared by the foreign key.
 */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;
    const { id } = await params;

    if (!(await checkRateLimit(user.id, RATE_LIMITS.mutateCampaign))) return rateLimited();

    const { error, count } = await supabase
      .from('campaigns')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('user_id', user.id);

    if (error) return serverError('campaigns:delete', error);
    if (!count) return notFound('Campaign');

    return ok({ deleted: true });
  } catch (error) {
    return serverError('campaigns:delete', error);
  }
}
