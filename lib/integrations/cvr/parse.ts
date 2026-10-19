import { employeeIntervalLabel } from './codes';

/**
 * Reads company documents from CVR's system-to-system index.
 *
 * The register keeps history: most values are arrays of entries with a
 * `periode { gyldigFra, gyldigTil }`, and the current one is the entry whose
 * `gyldigTil` is null. `virksomhedMetadata.nyeste*` holds the newest value
 * ready-made; it is preferred, with the arrays as fallback.
 *
 * Nothing is guessed. A field CVR does not have is left out, and contact
 * details marked `hemmelig` (secret) are never used.
 */

type Json = Record<string, unknown>;

const asObject = (v: unknown): Json | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const asText = (v: unknown): string | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

function isCurrent(entry: unknown): boolean {
  const periode = asObject(asObject(entry)?.periode);
  return !periode || periode.gyldigTil == null;
}

/** The current entry of a history array, else the newest one. */
function current(list: unknown): Json | null {
  const entries = asArray(list).map(asObject).filter((e): e is Json => e !== null);
  return entries.find(isCurrent) ?? entries.at(-1) ?? null;
}

export interface CvrDirector {
  /** The person's enhedsNummer in CVR — stable across name changes. */
  personId: string;
  name: string;
  title: string;
}

export interface CvrCompany {
  cvrNumber: string;
  name: string;
  active: boolean;
  reklamebeskyttet: boolean;
  status: string | null;
  founded: string | null;
  form: string | null;
  branchekode: string | null;
  branchetekst: string | null;
  employees: string | null;
  address: string | null;
  postnummer: string | null;
  city: string | null;
  kommune: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  directors: CvrDirector[];
}

function formatAddress(a: Json | null): string | null {
  if (!a) return null;
  const street = [asText(a.vejnavn), `${asText(a.husnummerFra) ?? ''}${asText(a.bogstavFra) ?? ''}`]
    .filter(Boolean)
    .join(' ')
    .trim();
  const etage = asText(a.etage);
  const door = asText(a.sidedoer);
  const unit = [etage ? `${etage}.` : null, door].filter(Boolean).join(' ');
  const line1 = [street, unit].filter(Boolean).join(', ');
  const line2 = [asText(a.postnummer), asText(a.postdistrikt)].filter(Boolean).join(' ');
  const full = [line1, line2].filter(Boolean).join(', ');
  return full || null;
}

/** First non-secret current value of a CVR contact list (telefonNummer etc.). */
function contact(list: unknown): string | null {
  for (const entry of asArray(list)) {
    const e = asObject(entry);
    if (!e || !isCurrent(e) || e.hemmelig === true) continue;
    const value = asText(e.kontaktoplysning);
    if (value) return value;
  }
  return null;
}

function normaliseWebsite(value: string | null): string | null {
  if (!value) return null;
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function employees(meta: Json | null): string | null {
  for (const key of ['nyesteMaanedsbeskaeftigelse', 'nyesteKvartalsbeskaeftigelse', 'nyesteAarsbeskaeftigelse']) {
    const b = asObject(meta?.[key]);
    if (!b) continue;
    const count = b.antalAnsatte;
    if (typeof count === 'number' && count >= 0) return String(count);
    const interval = asText(b.intervalKodeAntalAnsatte);
    if (interval) return employeeIntervalLabel(interval);
  }
  return null;
}

const ENDED = /ophør|opløst|konkurs|tvangs|likvidation|slettet/i;

const DIRECTOR_TITLE = /direkt|adm\.?\s*dir|\bceo\b/i;

/**
 * Current directors: people in the company's management body (LEDELSESORGAN)
 * whose current function is a director role, or who sit in the body named
 * "Direktion". Board members and auditors are not directors.
 */
export function currentDirectors(relations: unknown): CvrDirector[] {
  const directors = new Map<string, CvrDirector>();

  for (const rel of asArray(relations)) {
    const relation = asObject(rel);
    const deltager = asObject(relation?.deltager);
    if (!deltager) continue;
    const type = asText(deltager.enhedstype);
    if (type && type.toUpperCase() !== 'PERSON') continue;
    const personId = asText(deltager.enhedsNummer);
    const name = asText(current(deltager.navne)?.navn);
    if (!personId || !name) continue;

    for (const org of asArray(relation?.organisationer)) {
      const o = asObject(org);
      if (!o || asText(o.hovedtype)?.toUpperCase() !== 'LEDELSESORGAN') continue;
      const orgName = asText(current(o.organisationsNavn)?.navn) ?? '';

      for (const member of asArray(o.medlemsData)) {
        for (const attr of asArray(asObject(member)?.attributter)) {
          const a = asObject(attr);
          if (!a || asText(a.type)?.toUpperCase() !== 'FUNKTION') continue;
          for (const v of asArray(a.vaerdier)) {
            if (!isCurrent(v)) continue;
            const fn = asText(asObject(v)?.vaerdi) ?? '';
            if (DIRECTOR_TITLE.test(fn) || /^direktion$/i.test(orgName)) {
              if (!directors.has(personId)) {
                directors.set(personId, { personId, name, title: titleCase(fn) || 'Direktør' });
              }
            }
          }
        }
      }
    }
  }

  return [...directors.values()];
}

function titleCase(value: string): string {
  const v = value.trim();
  if (!v) return v;
  return v.charAt(0).toUpperCase() + v.slice(1).toLowerCase();
}

/** One search hit (`_source`) → company. Returns null for an unreadable hit. */
export function parseCvrCompany(source: unknown): CvrCompany | null {
  const root = asObject(asObject(source)?.Vrvirksomhed) ?? asObject(source);
  if (!root) return null;
  const cvrNumber = asText(root.cvrNummer);
  if (!cvrNumber || !/^\d{8}$/.test(cvrNumber)) return null;

  const meta = asObject(root.virksomhedMetadata);
  const name = asText(asObject(meta?.nyesteNavn)?.navn) ?? asText(current(root.navne)?.navn);
  if (!name) return null;

  const address = asObject(meta?.nyesteBeliggenhedsadresse) ?? current(root.beliggenhedsadresse);
  const branche = asObject(meta?.nyesteHovedbranche) ?? current(root.hovedbranche);
  const form = asObject(meta?.nyesteVirksomhedsform) ?? current(root.virksomhedsform);
  const kommune = asObject(address?.kommune);

  const status = asText(meta?.sammensatStatus);
  const lifespan = asArray(root.livsforloeb);
  const lifespanEnded = lifespan.length > 0 && !lifespan.some(isCurrent);
  const founded =
    asText(meta?.stiftelsesDato) ??
    asText(asObject(asObject(asArray(root.livsforloeb)[0])?.periode)?.gyldigFra);

  return {
    cvrNumber,
    name,
    active: !lifespanEnded && !(status && ENDED.test(status)),
    reklamebeskyttet: root.reklamebeskyttet === true,
    status,
    founded,
    form: asText(form?.kortBeskrivelse) ?? asText(form?.langBeskrivelse),
    branchekode: asText(branche?.branchekode),
    branchetekst: asText(branche?.branchetekst),
    employees: employees(meta),
    address: formatAddress(address),
    postnummer: asText(address?.postnummer),
    city: asText(address?.postdistrikt),
    kommune: asText(kommune?.kommuneNavn),
    phone: contact(root.telefonNummer),
    email: contact(root.elektroniskPost)?.toLowerCase() ?? null,
    website: normaliseWebsite(contact(root.hjemmeside)),
    directors: currentDirectors(root.deltagerRelation),
  };
}

/** Elasticsearch `hits.total` is a number before ES 7 and `{ value }` after. */
export function parseSearchResponse(body: unknown): { total: number; companies: CvrCompany[]; skipped: number } {
  const hits = asObject(asObject(body)?.hits);
  const rawTotal = hits?.total;
  const total =
    typeof rawTotal === 'number' ? rawTotal : Number(asObject(rawTotal)?.value ?? 0) || 0;

  const companies: CvrCompany[] = [];
  let skipped = 0;
  for (const hit of asArray(hits?.hits)) {
    const company = parseCvrCompany(asObject(hit)?._source);
    // Second line of defence: the query already excludes these.
    if (!company || !company.active || company.reklamebeskyttet) {
      skipped += 1;
      continue;
    }
    companies.push(company);
  }
  return { total, companies, skipped };
}

/** A lookup that may legitimately return protected companies (enrichment). */
export function parseLookupResponse(body: unknown): CvrCompany[] {
  const hits = asArray(asObject(asObject(body)?.hits)?.hits);
  return hits
    .map((hit) => parseCvrCompany(asObject(hit)?._source))
    .filter((c): c is CvrCompany => c !== null && c.active);
}

// ---------------------------------------------------------------------------
//  Leads
// ---------------------------------------------------------------------------

export interface CvrLeadRow {
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  job_title: string;
  company_name: string;
  company_website: string | null;
  location: string | null;
  industry: string | null;
  company_size: string | null;
  cvr_number: string;
  cvr_person_id: string;
  company_address: string | null;
  company_phone: string | null;
  company_email: string | null;
  source_url: string;
}

export function cvrSourceUrl(cvrNumber: string): string {
  return `https://datacvr.virk.dk/enhed/virksomhed/${cvrNumber}`;
}

function companySize(employeeCount: string | null): string | null {
  return employeeCount ? `${employeeCount} ansatte` : null;
}

function locationOf(c: CvrCompany): string | null {
  return [c.postnummer, c.city].filter(Boolean).join(' ') || null;
}

/** One lead per current director. A company without one yields none. */
export function companyToLeadRows(company: CvrCompany): CvrLeadRow[] {
  if (company.reklamebeskyttet || !company.active) return [];
  return company.directors.map((d) => {
    const parts = d.name.split(/\s+/).filter(Boolean);
    return {
      full_name: d.name,
      first_name: parts[0] ?? null,
      last_name: parts.length > 1 ? (parts.at(-1) ?? null) : null,
      job_title: d.title,
      company_name: company.name,
      company_website: company.website,
      location: locationOf(company),
      industry: company.branchetekst,
      company_size: companySize(company.employees),
      cvr_number: company.cvrNumber,
      cvr_person_id: d.personId,
      company_address: company.address,
      company_phone: company.phone,
      company_email: company.email,
      source_url: cvrSourceUrl(company.cvrNumber),
    };
  });
}

export const CVR_ENRICHABLE_FIELDS = [
  'cvr_number',
  'company_address',
  'company_phone',
  'company_email',
  'company_website',
  'industry',
  'company_size',
  'location',
] as const;

export type CvrEnrichableField = (typeof CVR_ENRICHABLE_FIELDS)[number];
export type CvrEnrichment = Partial<Record<CvrEnrichableField, string>>;

/** What CVR knows about the company, for the fields a lead can hold. */
export function companyEnrichment(company: CvrCompany): CvrEnrichment {
  const values: Record<CvrEnrichableField, string | null> = {
    cvr_number: company.cvrNumber,
    company_address: company.address,
    company_phone: company.phone,
    company_email: company.email,
    company_website: company.website,
    industry: company.branchetekst,
    company_size: companySize(company.employees),
    location: locationOf(company),
  };
  const out: CvrEnrichment = {};
  for (const key of CVR_ENRICHABLE_FIELDS) {
    const value = values[key];
    if (value) out[key] = value;
  }
  return out;
}

/** Only fills gaps; never replaces a value the lead already has. */
export function fillEmptyCvrFields(
  lead: Partial<Record<CvrEnrichableField, string | null>>,
  found: CvrEnrichment,
): CvrEnrichment {
  const patch: CvrEnrichment = {};
  for (const key of CVR_ENRICHABLE_FIELDS) {
    const value = found[key];
    if (value && !lead[key]) patch[key] = value;
  }
  return patch;
}

/** "Nordlys A/S" and "NORDLYS a/s." compare equal; legal-form suffixes are ignored. */
export function normaliseCompanyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[.,]/g, ' ')
    .replace(/\b(a\/s|aps|i\/s|k\/s|p\/s|ivs|as)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
