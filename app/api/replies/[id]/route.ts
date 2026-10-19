import { getAuthedContext } from '@/lib/api/auth';
import { RATE_LIMITS, checkRateLimit } from '@/lib/api/rate-limit';
import { notFound, ok, rateLimited, serverError, unauthorized } from '@/lib/api/response';

type Params = { params: Promise<{ id: string }> };

/** DELETE /api/replies/[id] — removes a reply recorded by mistake. */
export async function DELETE(_request: Request, { params }: Params) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;
    const { id } = await params;

    if (!(await checkRateLimit(user.id, RATE_LIMITS.mutateMessage))) return rateLimited();

    const { error, count } = await supabase
      .from('lead_replies')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('user_id', user.id);

    if (error) return serverError('replies:delete', error);
    if (!count) return notFound('Reply');
    return ok({ deleted: true });
  } catch (error) {
    return serverError('replies:delete', error);
  }
}
