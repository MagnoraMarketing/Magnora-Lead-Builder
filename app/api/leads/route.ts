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
import { applyLeadFilters } from '@/lib/leads/query';
import { bulkLeadActionSchema, leadListQuerySchema } from '@/lib/validation/schemas';
import type { Lead } from '@/types/database';

/** GET /api/leads — filtered, sorted, paginated list. */
export async function GET(request: NextRequest) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;

    const raw = Object.fromEntries(request.nextUrl.searchParams.entries());
    const parsed = leadListQuerySchema.safeParse(raw);
    if (!parsed.success) return validationError(parsed.error);
    const query = parsed.data;

    const from = (query.page - 1) * query.pageSize;
    const to = from + query.pageSize - 1;

    const filtered = applyLeadFilters(
      supabase.from('leads').select('*', { count: 'exact' }),
      user.id,
      query,
    );

    const { data, error, count } = await filtered
      .order(query.sort, { ascending: query.direction === 'asc' })
      .range(from, to)
      .returns<Lead[]>();

    if (error) return serverError('leads:list', error);

    return ok({
      items: data ?? [],
      total: count ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    });
  } catch (error) {
    return serverError('leads:list', error);
  }
}

/** POST /api/leads — bulk delete, status change or campaign assignment on selected leads. */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;

    if (!(await checkRateLimit(user.id, RATE_LIMITS.mutateLead))) return rateLimited();

    const parsed = bulkLeadActionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;

    if (input.action === 'delete') {
      const { error, count } = await supabase
        .from('leads')
        .delete({ count: 'exact' })
        .eq('user_id', user.id)
        .in('id', input.leadIds);

      if (error) return serverError('leads:bulk:delete', error);
      return ok({ affected: count ?? 0 });
    }

    if (input.action === 'set_campaign') {
      const { error, count } = await supabase
        .from('leads')
        .update({ campaign_id: input.campaignId }, { count: 'exact' })
        .eq('user_id', user.id)
        .in('id', input.leadIds);

      // The composite foreign key rejects a campaign the caller does not own.
      if (error?.code === '23503') return fail('invalid_campaign', 'That campaign does not exist.', 422);
      if (error) return serverError('leads:bulk:campaign', error);
      return ok({ affected: count ?? 0 });
    }

    const { error, count } = await supabase
      .from('leads')
      .update({ status: input.status }, { count: 'exact' })
      .eq('user_id', user.id)
      .in('id', input.leadIds);

    if (error) return serverError('leads:bulk:status', error);
    return ok({ affected: count ?? 0 });
  } catch (error) {
    return serverError('leads:bulk', error);
  }
}
