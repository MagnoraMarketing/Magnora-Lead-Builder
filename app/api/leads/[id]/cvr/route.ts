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
import { CVR_ERROR_STATUS, CvrRequestError, cvrSearch } from '@/lib/integrations/cvr/client';
import {
  companyEnrichment,
  fillEmptyCvrFields,
  normaliseCompanyName,
  parseLookupResponse,
  type CvrCompany,
} from '@/lib/integrations/cvr/parse';
import { buildCvrNumbersBody, buildNameLookupBody } from '@/lib/integrations/cvr/query';
import { doNotContact } from '@/lib/outreach/api';
import { cvrEnrichSchema } from '@/lib/validation/schemas';
import type { Json } from '@/types/supabase';
import type { Lead } from '@/types/database';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/leads/[id]/cvr — fills a lead's empty company fields from CVR.
 *
 * The company is found by, in order: a CVR number the user picked, the lead's
 * own CVR number, or an exact company-name match. When the name matches
 * several companies — or none exactly — the candidates are returned for the
 * user to choose from; nothing is guessed. Reklamebeskyttede companies are
 * refused, and only empty fields are ever filled.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const auth = await getAuthedContext();
    if (!auth) return unauthorized();
    const { user, supabase } = auth;
    const { id } = await params;

    const parsed = cvrEnrichSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return validationError(parsed.error);

    if (!(await checkRateLimit(user.id, RATE_LIMITS.cvrEnrich))) return rateLimited();

    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('*')
      .eq('id', id)
      .eq('user_id', user.id)
      .maybeSingle<Lead>();
    if (leadError) return serverError('cvr:enrich:lead', leadError);
    if (!lead) return notFound('Lead');
    if (lead.status === 'do_not_contact') return doNotContact();

    const cvrNumber = parsed.data.cvrNumber ?? lead.cvr_number;
    if (!cvrNumber && !lead.company_name?.trim()) {
      return fail('no_company', 'The lead has no company name or CVR number to look up.', 422);
    }

    let company: CvrCompany | null = null;
    try {
      if (cvrNumber) {
        company = parseLookupResponse(await cvrSearch(buildCvrNumbersBody([cvrNumber], { includeProtected: true })))[0] ?? null;
      } else {
        const candidates = parseLookupResponse(await cvrSearch(buildNameLookupBody(lead.company_name!.trim())));
        const wanted = normaliseCompanyName(lead.company_name!);
        const exact = candidates.filter((c) => normaliseCompanyName(c.name) === wanted);
        if (exact.length === 1) {
          company = exact[0] ?? null;
        } else if (candidates.length > 0) {
          return ok({
            outcome: 'choose' as const,
            candidates: candidates.map((c) => ({
              cvrNumber: c.cvrNumber,
              name: c.name,
              city: [c.postnummer, c.city].filter(Boolean).join(' ') || null,
              reklamebeskyttet: c.reklamebeskyttet,
            })),
          });
        }
      }
    } catch (error) {
      if (error instanceof CvrRequestError) return fail(error.code, error.message, CVR_ERROR_STATUS[error.code]);
      throw error;
    }

    const now = new Date().toISOString();

    if (!company) {
      await supabase
        .from('leads')
        .update({ enrichment_status: 'not_found', enriched_at: now })
        .eq('id', lead.id)
        .eq('user_id', user.id);
      return ok({ outcome: 'not_found' as const });
    }

    if (company.reklamebeskyttet) {
      return fail(
        'reklamebeskyttet',
        `${company.name} is reklamebeskyttet in CVR: the company has opted out of marketing contact, so its data is not used.`,
        422,
      );
    }

    const patch = fillEmptyCvrFields(lead, companyEnrichment(company));
    const { data: updated, error: updateError } = await supabase
      .from('leads')
      .update({ ...patch, enrichment_status: 'found', enriched_at: now })
      .eq('id', lead.id)
      .eq('user_id', user.id)
      .select()
      .maybeSingle<Lead>();
    if (updateError) return serverError('cvr:enrich:apply', updateError);

    // The parsed company, not the raw document: the raw one lists every
    // participant's history, which this lead has no use for.
    const { directors: _directors, ...companyRecord } = company;
    await supabase.from('enrichment_requests').insert({
      user_id: user.id,
      lead_id: lead.id,
      provider: 'cvr',
      status: 'completed',
      response: companyRecord as unknown as Json,
      completed_at: now,
    });

    return ok({
      outcome: 'found' as const,
      lead: updated ?? lead,
      company: { cvrNumber: company.cvrNumber, name: company.name },
      filled: Object.keys(patch),
    });
  } catch (error) {
    return serverError('cvr:enrich', error);
  }
}
