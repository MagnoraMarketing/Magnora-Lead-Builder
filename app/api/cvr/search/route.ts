import type { NextRequest } from 'next/server';
import { getAuthedContext } from '@/lib/api/auth';
import { RATE_LIMITS, checkRateLimit } from '@/lib/api/rate-limit';
import { fail, ok, rateLimited, serverError, unauthorized, validationError } from '@/lib/api/response';
import { CVR_ERROR_STATUS, CvrRequestError, cvrSearch } from '@/lib/integrations/cvr/client';
import { parseSearchResponse } from '@/lib/integrations/cvr/parse';
import {
  CVR_MAX_RESULTS,
  CVR_PAGE_SIZE,
  buildSearchBody,
  parseBrancheInput,
  parsePostalInput,
} from '@/lib/integrations/cvr/query';
import { cvrSearchSchema } from '@/lib/validation/schemas';

/**
 * POST /api/cvr/search — one page of active companies matching the criteria,
 * each with its current directors. Reklamebeskyttede companies are never
 * returned. Nothing is saved; /api/cvr/import does that.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;

    const parsed = cvrSearchSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return validationError(parsed.error);
    const input = parsed.data;

    const branche = parseBrancheInput(input.branche);
    if (!branche.ok) {
      return fail('validation_error', `“${branche.invalid}” is not a branche code.`, 422, {
        branche: ['Use 2–6 digit DB07 codes, e.g. 62 or 620100'],
      });
    }
    const postal = parsePostalInput(input.postnumre);
    if (!postal.ok) {
      return fail('validation_error', `“${postal.invalid}” is not a postal code or range.`, 422, {
        postnumre: ['Use four-digit codes or ranges, e.g. 8000 or 2000-2999'],
      });
    }

    const criteria = {
      branchekoder: branche.codes,
      kommunekoder: input.kommunekoder,
      postnumre: postal.ranges,
      employeeIntervals: input.employeeIntervals,
      formkoder: input.formkoder,
      minAgeYears: input.minAgeYears ?? null,
      maxAgeYears: input.maxAgeYears ?? null,
    };
    const hasCriterion =
      criteria.branchekoder.length + criteria.kommunekoder.length + criteria.postnumre.length +
        criteria.employeeIntervals.length + criteria.formkoder.length > 0 ||
      criteria.minAgeYears != null ||
      criteria.maxAgeYears != null;
    if (!hasCriterion) {
      return fail('validation_error', 'Choose at least one criterion.', 422);
    }

    const from = input.page * CVR_PAGE_SIZE;
    if (from + CVR_PAGE_SIZE > CVR_MAX_RESULTS) {
      return fail('too_many_results', `CVR returns at most ${CVR_MAX_RESULTS} results per search. Narrow it down.`, 422);
    }

    if (!(await checkRateLimit(user.id, RATE_LIMITS.cvrSearch))) return rateLimited();

    let raw: unknown;
    try {
      raw = await cvrSearch(buildSearchBody(criteria, { from, size: CVR_PAGE_SIZE }));
    } catch (error) {
      if (error instanceof CvrRequestError) return fail(error.code, error.message, CVR_ERROR_STATUS[error.code]);
      throw error;
    }

    const result = parseSearchResponse(raw);

    // Which of these companies the user already has leads from.
    const numbers = result.companies.map((c) => c.cvrNumber);
    const existing = new Map<string, number>();
    if (numbers.length > 0) {
      const { data, error } = await supabase
        .from('leads')
        .select('cvr_number')
        .eq('user_id', user.id)
        .in('cvr_number', numbers)
        .returns<{ cvr_number: string }[]>();
      if (error) return serverError('cvr:search:existing', error);
      for (const row of data ?? []) existing.set(row.cvr_number, (existing.get(row.cvr_number) ?? 0) + 1);
    }

    const reachable = Math.min(result.total, CVR_MAX_RESULTS);
    return ok({
      total: result.total,
      page: input.page,
      pageSize: CVR_PAGE_SIZE,
      hasMore: from + CVR_PAGE_SIZE < reachable,
      skipped: result.skipped,
      companies: result.companies.map((c) => ({ ...c, existingLeads: existing.get(c.cvrNumber) ?? 0 })),
    });
  } catch (error) {
    return serverError('cvr:search', error);
  }
}
