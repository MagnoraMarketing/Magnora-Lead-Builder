import { describe, expect, it } from 'vitest';
import { employeeIntervalLabel } from '@/lib/integrations/cvr/codes';
import {
  companyEnrichment,
  companyToLeadRows,
  currentDirectors,
  fillEmptyCvrFields,
  normaliseCompanyName,
  parseCvrCompany,
  parseSearchResponse,
} from '@/lib/integrations/cvr/parse';
import {
  CVR_FIELDS,
  buildCvrNumbersBody,
  buildNameLookupBody,
  buildSearchBody,
  parseBrancheInput,
  parsePostalInput,
} from '@/lib/integrations/cvr/query';

type Periode = { gyldigFra: string; gyldigTil: string | null };
const open: Periode = { gyldigFra: '2015-01-01', gyldigTil: null };
const closed: Periode = { gyldigFra: '2010-01-01', gyldigTil: '2014-12-31' };

function director(id: number, name: string, fn: string, periode = open, orgName = 'Direktion') {
  return {
    deltager: { enhedsNummer: id, enhedstype: 'PERSON', navne: [{ navn: name, periode: open }] },
    organisationer: [
      {
        hovedtype: 'LEDELSESORGAN',
        organisationsNavn: [{ navn: orgName, periode: open }],
        medlemsData: [{ attributter: [{ type: 'FUNKTION', vaerdier: [{ vaerdi: fn, periode }] }] }],
      },
    ],
  };
}

function companyDoc(overrides: Record<string, unknown> = {}) {
  return {
    Vrvirksomhed: {
      cvrNummer: 12345678,
      reklamebeskyttet: false,
      livsforloeb: [{ periode: open }],
      telefonNummer: [
        { kontaktoplysning: '11111111', hemmelig: true, periode: open },
        { kontaktoplysning: '70203040', hemmelig: false, periode: open },
      ],
      elektroniskPost: [
        { kontaktoplysning: 'old@nordlys.dk', hemmelig: false, periode: closed },
        { kontaktoplysning: 'Info@Nordlys.dk', hemmelig: false, periode: open },
      ],
      hjemmeside: [{ kontaktoplysning: 'www.nordlys.dk', hemmelig: false, periode: open }],
      deltagerRelation: [
        director(4001, 'Mette Kirstine Sørensen', 'ADM. DIREKTØR', open, 'Bestyrelse'),
        director(4002, 'Jens Hansen', 'BESTYRELSESMEDLEM', open, 'Bestyrelse'),
        director(4003, 'Ole Gammel', 'DIREKTØR', closed),
        director(4004, 'Lars Direktion', 'DIREKTION'),
      ],
      virksomhedMetadata: {
        nyesteNavn: { navn: 'Nordlys ApS' },
        sammensatStatus: 'Normal',
        stiftelsesDato: '2015-01-01',
        nyesteVirksomhedsform: { virksomhedsformkode: 80, kortBeskrivelse: 'APS' },
        nyesteHovedbranche: { branchekode: '620100', branchetekst: 'Computerprogrammering' },
        nyesteBeliggenhedsadresse: {
          vejnavn: 'Søndergade',
          husnummerFra: 12,
          bogstavFra: 'B',
          etage: '2',
          sidedoer: 'th',
          postnummer: 8000,
          postdistrikt: 'Aarhus C',
          kommune: { kommuneKode: 751, kommuneNavn: 'AARHUS' },
        },
        nyesteKvartalsbeskaeftigelse: { intervalKodeAntalAnsatte: 'ANTAL_10_19' },
      },
      ...overrides,
    },
  };
}

describe('CVR search body', () => {
  const now = new Date('2026-10-19T12:00:00Z');
  const body = buildSearchBody(
    {
      branchekoder: ['62'],
      kommunekoder: [751],
      postnumre: [{ from: 2000, to: 2999 }, { from: 8600, to: 8600 }],
      employeeIntervals: ['ANTAL_10_19'],
      formkoder: [80],
      minAgeYears: 3,
      maxAgeYears: 10,
    },
    { from: 25, size: 25 },
    now,
  ) as { query: { bool: { must: unknown[]; must_not: unknown[] } }; from: number; size: number };

  it('always excludes reklamebeskyttede and ended companies', () => {
    expect(body.query.bool.must_not).toContainEqual({ term: { [CVR_FIELDS.reklamebeskyttet]: true } });
    expect(JSON.stringify(body.query.bool.must_not)).toContain('Ophørt');
  });

  it('turns each criterion into a filter', () => {
    const must = JSON.stringify(body.query.bool.must);
    expect(must).toContain(`{"prefix":{"${CVR_FIELDS.branchekode}":"62"}}`);
    expect(must).toContain(`{"terms":{"${CVR_FIELDS.kommunekode}":[751]}}`);
    expect(must).toContain(`{"range":{"${CVR_FIELDS.postnummer}":{"gte":2000,"lte":2999}}}`);
    expect(must).toContain(`{"term":{"${CVR_FIELDS.postnummer}":8600}}`);
    expect(must).toContain(`{"terms":{"${CVR_FIELDS.formkode}":[80]}}`);
    expect(must).toContain('ANTAL_10_19');
    // 3–10 years old: founded between 11 years ago and 3 years ago.
    expect(must).toContain(`{"range":{"${CVR_FIELDS.founded}":{"lte":"2023-10-19","gte":"2015-10-19"}}}`);
    expect(body.from).toBe(25);
  });

  it('leaves out criteria that were not given', () => {
    const empty = buildSearchBody(
      { branchekoder: ['62'], kommunekoder: [], postnumre: [], employeeIntervals: [], formkoder: [] },
      { from: 0, size: 25 },
    ) as { query: { bool: { must: unknown[] } } };
    expect(empty.query.bool.must).toHaveLength(1);
  });

  it('keeps protected companies visible only to the lookups that must explain a refusal', () => {
    const mustNot = (body: unknown) =>
      JSON.stringify((body as { query: { bool: { must_not: unknown } } }).query.bool.must_not);
    expect(mustNot(buildCvrNumbersBody(['12345678']))).toContain('reklamebeskyttet');
    expect(mustNot(buildCvrNumbersBody(['12345678'], { includeProtected: true }))).not.toContain(
      'reklamebeskyttet',
    );
    expect(mustNot(buildNameLookupBody('Nordlys'))).not.toContain('reklamebeskyttet');
  });
});

describe('CVR input parsing', () => {
  it('reads postal codes and ranges', () => {
    expect(parsePostalInput('8000, 2000-2999;  5000')).toEqual({
      ok: true,
      ranges: [
        { from: 8000, to: 8000 },
        { from: 2000, to: 2999 },
        { from: 5000, to: 5000 },
      ],
    });
    expect(parsePostalInput('800')).toEqual({ ok: false, invalid: '800' });
    expect(parsePostalInput('3000-2000')).toEqual({ ok: false, invalid: '3000-2000' });
  });

  it('reads branche codes, with or without dots', () => {
    expect(parseBrancheInput('62, 47.11 62')).toEqual({ ok: true, codes: ['62', '4711'] });
    expect(parseBrancheInput('IT')).toEqual({ ok: false, invalid: 'IT' });
  });

  it('labels employee intervals', () => {
    expect(employeeIntervalLabel('ANTAL_10_19')).toBe('10–19');
    expect(employeeIntervalLabel('ANTAL_1_1')).toBe('1');
    expect(employeeIntervalLabel('ANTAL_1000_999999')).toBe('1000+');
  });
});

describe('CVR company parsing', () => {
  it('reads the current values and skips secret contact details', () => {
    const c = parseCvrCompany(companyDoc());
    expect(c).toMatchObject({
      cvrNumber: '12345678',
      name: 'Nordlys ApS',
      active: true,
      reklamebeskyttet: false,
      form: 'APS',
      branchekode: '620100',
      branchetekst: 'Computerprogrammering',
      employees: '10–19',
      address: 'Søndergade 12B, 2. th, 8000 Aarhus C',
      phone: '70203040',
      email: 'info@nordlys.dk',
      website: 'https://www.nordlys.dk',
      founded: '2015-01-01',
    });
  });

  it('finds current directors only — not board members or former directors', () => {
    const directors = currentDirectors(companyDoc().Vrvirksomhed.deltagerRelation);
    expect(directors.map((d) => d.name)).toEqual(['Mette Kirstine Sørensen', 'Lars Direktion']);
    expect(directors[0]).toEqual({ personId: '4001', name: 'Mette Kirstine Sørensen', title: 'Adm. direktør' });
  });

  it('marks ended companies inactive', () => {
    expect(parseCvrCompany(companyDoc({ livsforloeb: [{ periode: closed }] }))?.active).toBe(false);
    const ended = companyDoc();
    ended.Vrvirksomhed.virksomhedMetadata.sammensatStatus = 'Ophørt';
    expect(parseCvrCompany(ended)?.active).toBe(false);
  });

  it('drops protected and inactive companies from search results even if the query let them through', () => {
    const result = parseSearchResponse({
      hits: {
        total: { value: 3 },
        hits: [
          { _source: companyDoc() },
          { _source: companyDoc({ cvrNummer: 87654321, reklamebeskyttet: true }) },
          { _source: companyDoc({ cvrNummer: 11223344, livsforloeb: [{ periode: closed }] }) },
        ],
      },
    });
    expect(result.total).toBe(3);
    expect(result.companies.map((c) => c.cvrNumber)).toEqual(['12345678']);
    expect(result.skipped).toBe(2);
    expect(parseSearchResponse({ hits: { total: 7, hits: [] } }).total).toBe(7);
  });
});

describe('CVR leads and enrichment', () => {
  const company = parseCvrCompany(companyDoc())!;

  it('makes one lead per director, with the company contact details', () => {
    const rows = companyToLeadRows(company);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      full_name: 'Mette Kirstine Sørensen',
      first_name: 'Mette',
      last_name: 'Sørensen',
      job_title: 'Adm. direktør',
      company_name: 'Nordlys ApS',
      company_phone: '70203040',
      company_email: 'info@nordlys.dk',
      cvr_number: '12345678',
      cvr_person_id: '4001',
      company_size: '10–19 ansatte',
      location: '8000 Aarhus C',
      source_url: 'https://datacvr.virk.dk/enhed/virksomhed/12345678',
    });
    // Personal contact fields are never filled from company data.
    expect(rows[0]).not.toHaveProperty('email');
    expect(rows[0]).not.toHaveProperty('phone');
  });

  it('makes no leads from a protected company', () => {
    expect(companyToLeadRows({ ...company, reklamebeskyttet: true })).toEqual([]);
  });

  it('fills only empty fields', () => {
    const patch = fillEmptyCvrFields(
      { industry: 'Software', company_website: null, cvr_number: null },
      companyEnrichment(company),
    );
    expect(patch).not.toHaveProperty('industry');
    expect(patch.company_website).toBe('https://www.nordlys.dk');
    expect(patch.cvr_number).toBe('12345678');
  });

  it('compares company names without legal form or punctuation', () => {
    expect(normaliseCompanyName('NORDLYS A/S.')).toBe(normaliseCompanyName('Nordlys ApS'));
    expect(normaliseCompanyName('Nordlys Holding ApS')).not.toBe(normaliseCompanyName('Nordlys ApS'));
  });
});
