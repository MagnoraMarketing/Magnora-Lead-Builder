import type { NextRequest } from 'next/server';
import { getAuthedContext } from '@/lib/api/auth';
import { RATE_LIMITS, checkRateLimit } from '@/lib/api/rate-limit';
import { fail, ok, rateLimited, serverError, unauthorized, validationError } from '@/lib/api/response';
import { CVR_ERROR_STATUS, CvrRequestError, cvrSearch } from '@/lib/integrations/cvr/client';
import { companyToLeadRows, parseSearchResponse } from '@/lib/integrations/cvr/parse';
import { buildCvrNumbersBody } from '@/lib/integrations/cvr/query';
import { cvrImportSchema } from '@/lib/validation/schemas';
import type { Json } from '@/types/supabase';

/**
 * POST /api/cvr/import — turns the chosen companies' directors into leads.
 *
 * The companies are read again from CVR rather than taken from the browser,
 * so what is saved is what the register says now, and a company that became
 * reklamebeskyttet in the meantime is not imported. Existing leads are
 * skipped by the duplicate indexes, never overwritten.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;

    const parsed = cvrImportSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return validationError(parsed.error);
    const cvrNumbers = [...new Set(parsed.data.cvrNumbers)];

    if (!(await checkRateLimit(user.id, RATE_LIMITS.cvrImport))) return rateLimited();

    let raw: unknown;
    try {
      raw = await cvrSearch(buildCvrNumbersBody(cvrNumbers));
    } catch (error) {
      if (error instanceof CvrRequestError) return fail(error.code, error.message, CVR_ERROR_STATUS[error.code]);
      throw error;
    }

    const { companies } = parseSearchResponse(raw);
    const found = new Set(companies.map((c) => c.cvrNumber));
    const unavailable = cvrNumbers.filter((n) => !found.has(n));
    const withoutDirector = companies.filter((c) => c.directors.length === 0).map((c) => c.name);
    const rows = companies.flatMap(companyToLeadRows);

    let inserted = 0;
    let duplicates = 0;
    if (rows.length > 0) {
      const { data, error } = await supabase.rpc('import_cvr_leads', {
        p_rows: rows as unknown as Json,
        p_campaign_id: parsed.data.campaignId ?? null,
      });
      if (error?.code === '23503') return fail('invalid_campaign', 'That campaign does not exist.', 422);
      if (error) return serverError('cvr:import', error);
      inserted = data?.[0]?.inserted ?? 0;
      duplicates = data?.[0]?.skipped ?? 0;
    }

    return ok({ inserted, duplicates, withoutDirector, unavailable });
  } catch (error) {
    return serverError('cvr:import', error);
  }
}
