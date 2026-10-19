/**
 * CSV import: parsing, header mapping and row validation.
 *
 * Runs on the server (POST /api/leads/import) so nothing the browser sends is
 * trusted. Accepts the app's own export format (lib/leads/csv.ts) and common
 * header spellings, in English and Danish, so a file from a spreadsheet or
 * another tool usually imports without editing.
 *
 * Duplicate detection is not done here: the database's unique indexes decide
 * what already exists (see import_leads() in 0005_campaigns_and_outreach.sql).
 */
import { z } from 'zod';
import { LEAD_STATUSES, LEAD_STATUS_LABELS, type LeadStatus } from '@/lib/constants/leads';

export const MAX_IMPORT_ROWS = 1000;

/** Lead columns an import may set. */
export const IMPORT_FIELDS = [
  'full_name',
  'first_name',
  'last_name',
  'job_title',
  'company_name',
  'company_website',
  'company_linkedin_url',
  'linkedin_url',
  'location',
  'country',
  'industry',
  'company_size',
  'email',
  'phone',
  'mobile_phone',
  'status',
  'notes',
  'cvr_number',
  'company_address',
  'company_phone',
  'company_email',
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

/** Header spellings per field, compared after normalizeHeader(). */
const HEADER_ALIASES: Record<ImportField, string[]> = {
  full_name: ['name', 'full name', 'fullname', 'navn', 'fulde navn', 'contact', 'contact name'],
  first_name: ['first name', 'firstname', 'given name', 'fornavn'],
  last_name: ['last name', 'lastname', 'surname', 'family name', 'efternavn'],
  job_title: ['title', 'job title', 'position', 'role', 'stilling', 'titel'],
  company_name: ['company', 'company name', 'organisation', 'organization', 'firma', 'virksomhed'],
  company_website: ['company website', 'website', 'web', 'url', 'hjemmeside'],
  company_linkedin_url: ['company linkedin url', 'company linkedin'],
  linkedin_url: ['linkedin url', 'linkedin', 'linkedin profile', 'profile url', 'linkedin profil'],
  location: ['location', 'city', 'by', 'lokation'],
  country: ['country', 'land'],
  industry: ['industry', 'branche'],
  company_size: ['company size', 'employees', 'size', 'antal ansatte', 'størrelse'],
  email: ['email', 'e-mail', 'email address', 'mail', 'e-mail adresse'],
  phone: ['phone', 'phone number', 'telephone', 'telefon', 'tlf'],
  mobile_phone: ['mobile', 'mobile phone', 'cell', 'mobil', 'mobilnummer'],
  status: ['status'],
  notes: ['notes', 'note', 'noter', 'comments', 'kommentar'],
  cvr_number: ['cvr', 'cvr number', 'cvr nummer', 'cvr-nummer', 'cvrnr'],
  company_address: ['company address', 'address', 'adresse', 'firmaadresse'],
  company_phone: ['company phone', 'firmatelefon', 'virksomhedens telefon'],
  company_email: ['company email', 'company e-mail', 'firmamail', 'virksomhedens e-mail'],
};

function normalizeHeader(header: string): string {
  return header
    .replace(/^﻿/, '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, ' ');
}

const ALIAS_LOOKUP = new Map<string, ImportField>();
for (const field of IMPORT_FIELDS) {
  ALIAS_LOOKUP.set(normalizeHeader(field), field);
  for (const alias of HEADER_ALIASES[field]) ALIAS_LOOKUP.set(normalizeHeader(alias), field);
}

/**
 * RFC 4180 parser: quoted fields, doubled quotes, embedded commas and
 * newlines, CRLF or LF. Detects a semicolon delimiter, which Danish Excel
 * writes by default, from the header line.
 */
export function parseCsv(text: string): string[][] {
  const input = text.replace(/^﻿/, '');
  const firstLine = input.slice(0, input.search(/\r?\n|$/));
  const delimiter =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Blank lines are not rows.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

/**
 * Undoes the export's formula guard: lib/leads/csv.ts prefixes a value that
 * starts with =, +, -, @, tab or CR with an apostrophe. Re-exporting applies
 * the guard again, so the round trip is lossless and still safe.
 */
function unescapeFormulaGuard(value: string): string {
  return /^'[=+\-@\t\r]/.test(value) ? value.slice(1) : value;
}

const STATUS_BY_TEXT = new Map<string, LeadStatus>();
for (const status of LEAD_STATUSES) {
  STATUS_BY_TEXT.set(status, status);
  STATUS_BY_TEXT.set(LEAD_STATUS_LABELS[status].toLowerCase(), status);
}

const optional = (max: number) => z.string().max(max, `Must be at most ${max} characters`).nullable();
const optionalUrl = z.string().url('Must be a valid URL').max(500).nullable();

const importRowSchema = z.object({
  full_name: z.string().min(1, 'A name is required').max(200),
  first_name: optional(100),
  last_name: optional(100),
  job_title: optional(200),
  company_name: optional(200),
  company_website: optionalUrl,
  company_linkedin_url: optionalUrl,
  linkedin_url: optionalUrl,
  location: optional(200),
  country: optional(100),
  industry: optional(100),
  company_size: optional(50),
  email: z.string().email('Must be a valid email address').max(320).nullable(),
  phone: optional(50),
  mobile_phone: optional(50),
  status: z.enum(LEAD_STATUSES),
  notes: optional(10000),
  cvr_number: z.string().regex(/^\d{8}$/, 'A CVR number has 8 digits').nullable(),
  company_address: optional(300),
  company_phone: optional(50),
  company_email: z.string().email('Must be a valid email address').max(320).nullable(),
});

export type ImportRow = z.infer<typeof importRowSchema>;

export interface RowError {
  /** 1-based line number in the file, counting the header as line 1. */
  line: number;
  messages: string[];
}

export interface ParsedImport {
  rows: ImportRow[];
  errors: RowError[];
  /** Headers that matched no field and were ignored. */
  ignoredHeaders: string[];
  /** Problems with the file as a whole. Non-empty means nothing can be imported. */
  fileErrors: string[];
}

/** Adds a scheme to a bare domain, so "acme.dk" imports as "https://acme.dk". */
function withScheme(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

export function parseLeadImport(text: string): ParsedImport {
  const result: ParsedImport = { rows: [], errors: [], ignoredHeaders: [], fileErrors: [] };
  const table = parseCsv(text);

  if (table.length < 2) {
    result.fileErrors.push('The file needs a header row and at least one lead.');
    return result;
  }

  const [header, ...body] = table as [string[], ...string[][]];
  const columns: (ImportField | null)[] = header.map((h) => ALIAS_LOOKUP.get(normalizeHeader(h)) ?? null);
  result.ignoredHeaders = header.filter((h, i) => columns[i] === null && h.trim() !== '');

  const hasName =
    columns.includes('full_name') || (columns.includes('first_name') && columns.includes('last_name'));
  if (!hasName) {
    result.fileErrors.push(
      'No name column found. Add a "Name" column, or both "First name" and "Last name".',
    );
    return result;
  }

  if (body.length > MAX_IMPORT_ROWS) {
    result.fileErrors.push(
      `The file has ${body.length} leads; at most ${MAX_IMPORT_ROWS} can be imported at once. Split it into smaller files.`,
    );
    return result;
  }

  body.forEach((cells, index) => {
    const line = index + 2;
    const raw: Partial<Record<ImportField, string>> = {};
    columns.forEach((field, i) => {
      if (!field) return;
      const value = unescapeFormulaGuard((cells[i] ?? '').trim());
      // First non-empty column wins when two headers map to the same field.
      if (value && !raw[field]) raw[field] = value;
    });

    const fullName =
      raw.full_name ?? ([raw.first_name, raw.last_name].filter(Boolean).join(' ') || undefined);

    const statusText = raw.status?.toLowerCase();
    const status = statusText ? STATUS_BY_TEXT.get(statusText) : 'new';

    const candidate = {
      full_name: fullName ?? '',
      first_name: raw.first_name ?? null,
      last_name: raw.last_name ?? null,
      job_title: raw.job_title ?? null,
      company_name: raw.company_name ?? null,
      company_website: raw.company_website ? withScheme(raw.company_website) : null,
      company_linkedin_url: raw.company_linkedin_url ? withScheme(raw.company_linkedin_url) : null,
      linkedin_url: raw.linkedin_url ? withScheme(raw.linkedin_url) : null,
      location: raw.location ?? null,
      country: raw.country ?? null,
      industry: raw.industry ?? null,
      company_size: raw.company_size ?? null,
      email: raw.email ?? null,
      phone: raw.phone ?? null,
      mobile_phone: raw.mobile_phone ?? null,
      status: status ?? '',
      notes: raw.notes ?? null,
      cvr_number: raw.cvr_number ? raw.cvr_number.replace(/^DK/i, '').replace(/\s+/g, '') : null,
      company_address: raw.company_address ?? null,
      company_phone: raw.company_phone ?? null,
      company_email: raw.company_email ?? null,
    };

    const parsed = importRowSchema.safeParse(candidate);
    if (parsed.success) {
      result.rows.push(parsed.data);
    } else {
      result.errors.push({
        line,
        messages: parsed.error.issues.map((issue) =>
          issue.path[0] === 'status'
            ? `Unknown status "${raw.status}"`
            : `${String(issue.path[0] ?? 'row')}: ${issue.message}`,
        ),
      });
    }
  });

  return result;
}
