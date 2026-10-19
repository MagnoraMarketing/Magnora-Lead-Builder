import { getAuthedContext } from '@/lib/api/auth';
import { RATE_LIMITS, checkRateLimit } from '@/lib/api/rate-limit';
import {
  notFound,
  ok,
  rateLimited,
  serverError,
  unauthorized,
  validationError,
} from '@/lib/api/response';
import { campaignStepsSchema } from '@/lib/validation/schemas';
import type { CampaignStep } from '@/types/database';

type Params = { params: Promise<{ id: string }> };

async function campaignExists(
  supabase: NonNullable<Awaited<ReturnType<typeof getAuthedContext>>>['supabase'],
  userId: string,
  campaignId: string,
) {
  const { data, error } = await supabase
    .from('campaigns')
    .select('id')
    .eq('id', campaignId)
    .eq('user_id', userId)
    .maybeSingle<{ id: string }>();
  return { exists: Boolean(data), error };
}

/** GET /api/campaigns/[id]/steps — the follow-up sequence, step 2 onwards. */
export async function GET(_request: Request, { params }: Params) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;
    const { id } = await params;

    const { data, error } = await supabase
      .from('campaign_steps')
      .select('*')
      .eq('campaign_id', id)
      .eq('user_id', user.id)
      .order('step_number', { ascending: true })
      .returns<CampaignStep[]>();

    if (error) return serverError('campaign-steps:list', error);
    return ok({ steps: data ?? [] });
  } catch (error) {
    return serverError('campaign-steps:list', error);
  }
}

/**
 * PUT /api/campaigns/[id]/steps — replaces the sequence.
 *
 * Array position decides the step: the first entry is step 2 (the first
 * follow-up). Steps are upserted by number, then any beyond the new length
 * are removed, so a failure part-way never leaves the campaign with no steps.
 * Follow-ups already planned for leads keep the topic they were planned with.
 */
export async function PUT(request: Request, { params }: Params) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;
    const { id } = await params;

    if (!(await checkRateLimit(user.id, RATE_LIMITS.mutateCampaign))) return rateLimited();

    const parsed = campaignStepsSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return validationError(parsed.error);
    const { steps } = parsed.data;

    const owner = await campaignExists(supabase, user.id, id);
    if (owner.error) return serverError('campaign-steps:owner', owner.error);
    if (!owner.exists) return notFound('Campaign');

    if (steps.length > 0) {
      const { error } = await supabase.from('campaign_steps').upsert(
        steps.map((step, index) => ({
          user_id: user.id,
          campaign_id: id,
          step_number: index + 2,
          delay_days: step.delayDays,
          topic: step.topic ?? null,
          channel: step.channel,
        })),
        { onConflict: 'campaign_id,step_number' },
      );
      if (error) return serverError('campaign-steps:upsert', error);
    }

    const { error: trimError } = await supabase
      .from('campaign_steps')
      .delete()
      .eq('campaign_id', id)
      .eq('user_id', user.id)
      .gt('step_number', steps.length + 1);
    if (trimError) return serverError('campaign-steps:trim', trimError);

    const { data, error } = await supabase
      .from('campaign_steps')
      .select('*')
      .eq('campaign_id', id)
      .eq('user_id', user.id)
      .order('step_number', { ascending: true })
      .returns<CampaignStep[]>();
    if (error) return serverError('campaign-steps:reload', error);

    return ok({ steps: data ?? [] });
  } catch (error) {
    return serverError('campaign-steps:put', error);
  }
}
