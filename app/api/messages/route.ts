import type { NextRequest } from 'next/server';
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
import { MESSAGE_LEAD_SELECT, doNotContact } from '@/lib/outreach/api';
import { createMessageSchema, messageListQuerySchema } from '@/lib/validation/schemas';
import type { Lead, OutreachMessage, OutreachMessageWithLead } from '@/types/database';

/** GET /api/messages — the outreach queue, filtered and paginated. */
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;

    const raw = Object.fromEntries(request.nextUrl.searchParams.entries());
    const parsed = messageListQuerySchema.safeParse(raw);
    if (!parsed.success) return validationError(parsed.error);
    const query = parsed.data;

    const from = (query.page - 1) * query.pageSize;
    const to = from + query.pageSize - 1;

    let q = supabase
      .from('outreach_messages')
      .select(MESSAGE_LEAD_SELECT, { count: 'exact' })
      .eq('user_id', user.id);

    if (query.status) q = q.eq('status', query.status);
    if (query.campaignId) q = q.eq('campaign_id', query.campaignId);
    if (query.leadId) q = q.eq('lead_id', query.leadId);

    const { data, error, count } = await q
      .order(query.sort === 'created' ? 'created_at' : 'updated_at', { ascending: false })
      .range(from, to)
      .returns<OutreachMessageWithLead[]>();

    if (error) return serverError('messages:list', error);

    return ok({
      items: data ?? [],
      total: count ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    });
  } catch (error) {
    return serverError('messages:list', error);
  }
}

/** POST /api/messages — a hand-written draft. */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;

    if (!(await checkRateLimit(user.id, RATE_LIMITS.mutateMessage))) return rateLimited();

    const parsed = createMessageSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;

    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('id, status, campaign_id')
      .eq('id', input.leadId)
      .eq('user_id', user.id)
      .maybeSingle<Pick<Lead, 'id' | 'status' | 'campaign_id'>>();

    if (leadError) return serverError('messages:create:lead', leadError);
    if (!lead) return notFound('Lead');
    if (lead.status === 'do_not_contact') return doNotContact();

    const { data, error } = await supabase
      .from('outreach_messages')
      .insert({
        user_id: user.id,
        lead_id: lead.id,
        campaign_id: input.campaignId === undefined ? lead.campaign_id : input.campaignId,
        channel: input.channel,
        body: input.body,
        source: 'manual',
      })
      .select()
      .single<OutreachMessage>();

    if (error?.code === '23503') return fail('invalid_campaign', 'That campaign does not exist.', 422);
    if (error) return serverError('messages:create', error);

    return ok({ message: data }, 201);
  } catch (error) {
    return serverError('messages:create', error);
  }
}
