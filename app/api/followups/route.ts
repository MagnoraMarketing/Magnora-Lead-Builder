import type { NextRequest } from 'next/server';
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
import { doNotContact } from '@/lib/outreach/api';
import { FOLLOW_UP_LEAD_SELECT } from '@/lib/outreach/followups';
import { createFollowUpSchema } from '@/lib/validation/schemas';
import type { FollowUpTask, FollowUpTaskWithLead, Lead } from '@/types/database';

/** GET /api/followups?leadId= — open follow-ups, soonest first. */
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;

    const leadId = request.nextUrl.searchParams.get('leadId');

    let q = supabase
      .from('follow_up_tasks')
      .select(FOLLOW_UP_LEAD_SELECT)
      .eq('user_id', user.id)
      .in('status', ['pending', 'drafted']);
    if (leadId) q = q.eq('lead_id', leadId);

    const { data, error } = await q
      .order('due_at', { ascending: true })
      .limit(200)
      .returns<FollowUpTaskWithLead[]>();

    if (error) return serverError('followups:list', error);
    return ok({ items: data ?? [] });
  } catch (error) {
    return serverError('followups:list', error);
  }
}

/** POST /api/followups — plan a follow-up for a lead, at a chosen time and topic. */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;

    if (!(await checkRateLimit(user.id, RATE_LIMITS.mutateMessage))) return rateLimited();

    const parsed = createFollowUpSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;

    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('id, status, campaign_id')
      .eq('id', input.leadId)
      .eq('user_id', user.id)
      .maybeSingle<Pick<Lead, 'id' | 'status' | 'campaign_id'>>();
    if (leadError) return serverError('followups:create:lead', leadError);
    if (!lead) return notFound('Lead');
    if (lead.status === 'do_not_contact') return doNotContact();

    // Planned by hand: no campaign step, so it never collides with the sequence.
    const { data, error } = await supabase
      .from('follow_up_tasks')
      .insert({
        user_id: user.id,
        lead_id: lead.id,
        topic: input.topic ?? null,
        channel: input.channel,
        due_at: input.dueAt,
      })
      .select()
      .single<FollowUpTask>();

    if (error) return serverError('followups:create', error);
    return ok({ followUp: data }, 201);
  } catch (error) {
    return serverError('followups:create', error);
  }
}
