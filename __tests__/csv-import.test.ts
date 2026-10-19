import { describe, expect, it } from 'vitest';
import { leadsToCsv } from '@/lib/leads/csv';
import { MAX_IMPORT_ROWS, parseCsv, parseLeadImport } from '@/lib/leads/csv-import';
import type { Lead } from '@/types/database';

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, embedded commas and newlines', () => {
    const rows = parseCsv('a,b,c\r\n"x, y","say ""hi""","line1\nline2"\r\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'line1\nline2'],
    ]);
  });

  it('strips a UTF-8 BOM and skips blank lines', () => {
    expect(parseCsv('﻿Name\n\nJens\n')).toEqual([['Name'], ['Jens']]);
  });

  it('detects the semicolon delimiter Danish Excel writes', () => {
    expect(parseCsv('Navn;Firma\nJens Hansen;Acme, A/S\n')).toEqual([
      ['Navn', 'Firma'],
      ['Jens Hansen', 'Acme, A/S'],
    ]);
  });

  it('keeps a final row without a trailing newline', () => {
    expect(parseCsv('Name\nJens')).toEqual([['Name'], ['Jens']]);
  });
});

describe('parseLeadImport', () => {
  it('maps English and Danish headers and defaults status to new', () => {
    const result = parseLeadImport(
      'Fornavn;Efternavn;Stilling;Virksomhed;E-mail;LinkedIn\nMette;Sørensen;CFO;Nordlys A/S;mette@nordlys.dk;linkedin.com/in/mette\n',
    );
    expect(result.fileErrors).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      full_name: 'Mette Sørensen',
      first_name: 'Mette',
      job_title: 'CFO',
      company_name: 'Nordlys A/S',
      email: 'mette@nordlys.dk',
      linkedin_url: 'https://linkedin.com/in/mette',
      status: 'new',
    });
  });

  it('reports invalid rows by line number and imports the rest', () => {
    const result = parseLeadImport('Name,Email,Status\nGood One,good@a.dk,Qualified\n,x@a.dk,\nBad Mail,not-an-email,\nOdd,,Maybe\n');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.status).toBe('qualified');
    expect(result.errors.map((e) => e.line)).toEqual([3, 4, 5]);
    expect(result.errors[2]?.messages[0]).toContain('Unknown status "Maybe"');
  });

  it('refuses a file without a name column', () => {
    expect(parseLeadImport('Company,Email\nAcme,a@b.dk\n').fileErrors[0]).toMatch(/No name column/);
  });

  it('refuses a file over the row limit', () => {
    const csv = `Name\n${Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `Lead ${i}`).join('\n')}`;
    expect(parseLeadImport(csv).fileErrors[0]).toMatch(/at most 1000/);
  });

  it('lists unrecognised headers instead of failing', () => {
    expect(parseLeadImport('Name,Favourite colour\nJens,blue\n').ignoredHeaders).toEqual([
      'Favourite colour',
    ]);
  });

  it('round-trips the app’s own export, including formula-guarded values', () => {
    const lead = {
      full_name: 'Jens Hansen',
      job_title: '-CFO-',
      company_name: '=Acme A/S',
      company_website: 'https://acme.dk',
      linkedin_url: 'https://www.linkedin.com/in/jens-hansen',
      location: 'Copenhagen, Denmark',
      industry: 'finance',
      company_size: '50-100',
      email: 'jens@acme.dk',
      phone: '+45 11 22 33 44',
      mobile_phone: null,
      status: 'interested',
      notes: 'Said "call me", then left.\nFollow up.',
    } as unknown as Lead;

    const result = parseLeadImport(leadsToCsv([lead]));
    expect(result.errors).toEqual([]);
    expect(result.ignoredHeaders).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      full_name: 'Jens Hansen',
      job_title: '-CFO-',
      company_name: '=Acme A/S',
      phone: '+45 11 22 33 44',
      status: 'interested',
      notes: 'Said "call me", then left.\nFollow up.',
    });
  });
});
