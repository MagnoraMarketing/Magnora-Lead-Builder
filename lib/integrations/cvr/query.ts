/**
 * Elasticsearch request bodies for CVR's system-to-system index
 * (`cvr-permanent/virksomhed/_search`).
 *
 * Only plain `bool` / `match` / `terms` / `prefix` / `range` queries are used,
 * so the bodies work on the old Elasticsearch version the register runs and on
 * newer ones alike.
 *
 * Every body excludes reklamebeskyttede companies. They have asked not to be
 * contacted for marketing, and the register's terms require users to respect
 * that; the parser drops them a second time in case the filter misses.
 */

const ROOT = 'Vrvirksomhed';
const META = `${ROOT}.virksomhedMetadata`;

export const CVR_FIELDS = {
  cvrNumber: `${ROOT}.cvrNummer`,
  reklamebeskyttet: `${ROOT}.reklamebeskyttet`,
  status: `${META}.sammensatStatus`,
  founded: `${META}.stiftelsesDato`,
  name: `${META}.nyesteNavn.navn`,
  branchekode: `${META}.nyesteHovedbranche.branchekode`,
  formkode: `${META}.nyesteVirksomhedsform.virksomhedsformkode`,
  kommunekode: `${META}.nyesteBeliggenhedsadresse.kommune.kommuneKode`,
  postnummer: `${META}.nyesteBeliggenhedsadresse.postnummer`,
  employeeIntervals: [
    `${META}.nyesteMaanedsbeskaeftigelse.intervalKodeAntalAnsatte`,
    `${META}.nyesteKvartalsbeskaeftigelse.intervalKodeAntalAnsatte`,
    `${META}.nyesteAarsbeskaeftigelse.intervalKodeAntalAnsatte`,
  ],
} as const;

/** Only what the parser reads; deltagerRelation carries the directors. */
export const CVR_SOURCE_FIELDS = [
  `${ROOT}.cvrNummer`,
  `${ROOT}.reklamebeskyttet`,
  `${ROOT}.navne`,
  `${ROOT}.livsforloeb`,
  `${ROOT}.beliggenhedsadresse`,
  `${ROOT}.hovedbranche`,
  `${ROOT}.virksomhedsform`,
  `${ROOT}.telefonNummer`,
  `${ROOT}.elektroniskPost`,
  `${ROOT}.hjemmeside`,
  `${ROOT}.deltagerRelation`,
  META,
];

/** Statuses of companies that no longer trade. Matched case-insensitively. */
const ENDED_STATUSES = [
  'Ophørt',
  'Opløst',
  'OPLØSTEFTERKONKURS',
  'OPLØSTEFTERFRIVILLIGLIKVIDATION',
  'OPLØSTEFTERERKLÆRING',
  'OPLØSTEFTERFUSION',
  'OPLØSTEFTERSPALTNING',
  'TVANGSOPLØST',
  'UNDERKONKURS',
  'UNDERTVANGSOPLØSNING',
  'UNDERFRIVILLIGLIKVIDATION',
  'Slettet',
];

/** The register serves at most this many hits per query (from + size). */
export const CVR_MAX_RESULTS = 3000;
export const CVR_PAGE_SIZE = 25;

export interface PostalRange {
  from: number;
  to: number;
}

export interface CvrSearchCriteria {
  /** DB07 codes or prefixes, e.g. "62" (IT) or "620100". */
  branchekoder: string[];
  kommunekoder: number[];
  postnumre: PostalRange[];
  employeeIntervals: string[];
  formkoder: number[];
  /** Company age in whole years, from the founding date. */
  minAgeYears?: number | null;
  maxAgeYears?: number | null;
}

type Query = Record<string, unknown>;

const anyOf = (queries: Query[]): Query | null =>
  queries.length === 0 ? null : queries.length === 1 ? (queries[0] ?? null) : { bool: { should: queries, minimum_should_match: 1 } };

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

function yearsBefore(now: Date, years: number): Date {
  const d = new Date(now);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d;
}

/**
 * Companies that have stopped trading, and — unless the caller needs to see
 * them to explain a refusal — reklamebeskyttede companies.
 */
function exclusions({ includeProtected = false } = {}): Query[] {
  return [
    ...(includeProtected ? [] : [{ term: { [CVR_FIELDS.reklamebeskyttet]: true } }]),
    ...ENDED_STATUSES.map((status) => ({ match: { [CVR_FIELDS.status]: status } })),
  ];
}

export function buildSearchBody(
  criteria: CvrSearchCriteria,
  page: { from: number; size: number },
  now: Date = new Date(),
): Query {
  const must: Query[] = [];

  const branche = anyOf(
    criteria.branchekoder.map((code) => ({ prefix: { [CVR_FIELDS.branchekode]: code } })),
  );
  if (branche) must.push(branche);

  // Kommuner and postnumre widen each other: "Aarhus or 8600–8700".
  const place = anyOf([
    ...(criteria.kommunekoder.length > 0
      ? [{ terms: { [CVR_FIELDS.kommunekode]: criteria.kommunekoder } }]
      : []),
    ...criteria.postnumre.map(({ from, to }) =>
      from === to
        ? { term: { [CVR_FIELDS.postnummer]: from } }
        : { range: { [CVR_FIELDS.postnummer]: { gte: from, lte: to } } },
    ),
  ]);
  if (place) must.push(place);

  // CVR reports staff monthly, quarterly or yearly depending on the company;
  // the newest of any of them counts.
  const employees = anyOf(
    criteria.employeeIntervals.flatMap((code) =>
      CVR_FIELDS.employeeIntervals.map((field) => ({ match: { [field]: code } })),
    ),
  );
  if (employees) must.push(employees);

  if (criteria.formkoder.length > 0) {
    must.push({ terms: { [CVR_FIELDS.formkode]: criteria.formkoder } });
  }

  // Older than N years = founded on or before today minus N years.
  const founded: Record<string, string> = {};
  if (criteria.minAgeYears != null) founded.lte = isoDate(yearsBefore(now, criteria.minAgeYears));
  if (criteria.maxAgeYears != null) founded.gte = isoDate(yearsBefore(now, criteria.maxAgeYears + 1));
  if (Object.keys(founded).length > 0) must.push({ range: { [CVR_FIELDS.founded]: founded } });

  return {
    _source: CVR_SOURCE_FIELDS,
    from: page.from,
    size: page.size,
    sort: [{ [CVR_FIELDS.cvrNumber]: { order: 'asc' } }],
    query: { bool: { must, must_not: exclusions() } },
  };
}

/**
 * Exact lookup of known CVR numbers. Import re-reads the chosen companies this
 * way; enrichment passes `includeProtected` so it can tell the user why a
 * protected company is refused instead of reporting "not found".
 */
export function buildCvrNumbersBody(
  cvrNumbers: string[],
  { includeProtected = false } = {},
): Query {
  return {
    _source: CVR_SOURCE_FIELDS,
    size: cvrNumbers.length,
    query: {
      bool: {
        must: [{ terms: { [CVR_FIELDS.cvrNumber]: cvrNumbers.map(Number) } }],
        must_not: exclusions({ includeProtected }),
      },
    },
  };
}

/**
 * Name lookup for enriching a lead that has no CVR number yet. Protected
 * companies are included so the caller can refuse them by name.
 */
export function buildNameLookupBody(companyName: string, size = 10): Query {
  return {
    _source: CVR_SOURCE_FIELDS,
    size,
    query: {
      bool: {
        must: [{ match_phrase: { [CVR_FIELDS.name]: companyName } }],
        must_not: exclusions({ includeProtected: true }),
      },
    },
  };
}

/**
 * Parses "2000-2999, 8000; 8200" into ranges. Returns null with the offending
 * piece when something is not a Danish postal code.
 */
export function parsePostalInput(
  input: string,
): { ok: true; ranges: PostalRange[] } | { ok: false; invalid: string } {
  const ranges: PostalRange[] = [];
  for (const raw of input.split(/[,;\s]+/)) {
    const piece = raw.trim();
    if (!piece) continue;
    const match = /^(\d{4})(?:[-–](\d{4}))?$/.exec(piece);
    if (!match) return { ok: false, invalid: piece };
    const from = Number(match[1]);
    const to = Number(match[2] ?? match[1]);
    if (to < from) return { ok: false, invalid: piece };
    ranges.push({ from, to });
  }
  return { ok: true, ranges };
}

/** Parses "62, 4711 47.11" into digit-only branche prefixes. */
export function parseBrancheInput(input: string): { ok: true; codes: string[] } | { ok: false; invalid: string } {
  const codes: string[] = [];
  for (const raw of input.split(/[,;\s]+/)) {
    const piece = raw.trim().replace(/\./g, '');
    if (!piece) continue;
    if (!/^\d{2,6}$/.test(piece)) return { ok: false, invalid: raw.trim() };
    codes.push(piece);
  }
  return { ok: true, codes: [...new Set(codes)] };
}
