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
import { parseLeadImport } from '@/lib/leads/csv-import';
import { importLeadsSchema } from '@/lib/validation/schemas';

/**
 * POST /api/leads/import — imports leads from CSV text.
 *
 * The file is parsed and every row validated here. Valid rows go to
 * import_leads(), which runs as the caller (RLS applies) and lets the
 * duplicate-detection indexes skip leads that already exist. Invalid rows are
 * reported back by line number and not imported.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;

    if (!(await checkRateLimit(user.id, RATE_LIMITS.importLeads))) return rateLimited();

    const parsed = importLeadsSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return validationError(parsed.error);
    const { csv, campaignId } = parsed.data;

    const result = parseLeadImport(csv);
    if (result.fileErrors.length > 0) {
      return fail('invalid_file', result.fileErrors.join(' '), 422);
    }

    let inserted = 0;
    let duplicates = 0;

    if (result.rows.length > 0) {
      const { data, error } = await supabase.rpc('import_leads', {
        p_rows: result.rows,
        p_campaign_id: campaignId ?? null,
      });

      if (error?.code === '23503') return fail('invalid_campaign', 'That campaign does not exist.', 422);
      if (error) return serverError('leads:import', error);

      inserted = data?.[0]?.inserted ?? 0;
      duplicates = data?.[0]?.skipped ?? 0;
    }

    return ok({
      inserted,
      duplicates,
      invalid: result.errors,
      ignoredHeaders: result.ignoredHeaders,
    });
  } catch (error) {
    return serverError('leads:import', error);
  }
}
