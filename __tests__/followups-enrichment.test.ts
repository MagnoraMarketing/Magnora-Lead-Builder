import { describe, expect, it } from 'vitest';
import {
  buildApolloParams,
  parseApolloMatch,
  parseApolloPhoneWebhook,
} from '@/lib/integrations/enrichment/apollo';
import { fillEmptyFields } from '@/lib/integrations/enrichment/apply';
import { buildConversation, inferKind } from '@/lib/outreach/context';
import { buildOutreachPrompt, type LeadFacts } from '@/lib/outreach/prompt';
import { fromLocalInput, toLocalInput } from '@/lib/datetime';
import type { Lead } from '@/types/database';

const lead = {
  full_name: 'Mette Sørensen',
  first_name: 'Mette',
  last_name: 'Sørensen',
  company_name: 'Nordlys A/S',
  company_website: 'https://www.nordlys.dk/om',
  linkedin_url: 'https://www.linkedin.com/in/mette',
  email: null,
  phone: null,
  mobile_phone: null,
  industry: null,
  company_size: null,
} as unknown as Lead;

describe('Apollo request', () => {
  it('sends only the fields the lead has, and asks for phones only with a webhook', () => {
    const plain = buildApolloParams(lead);
    expect(plain.get('first_name')).toBe('Mette');
    expect(plain.get('organization_name')).toBe('Nordlys A/S');
    expect(plain.get('domain')).toBe('nordlys.dk');
    expect(plain.get('reveal_personal_emails')).toBe('false');
    expect(plain.has('reveal_phone_number')).toBe(false);

    const withHook = buildApolloParams(lead, { webhookUrl: 'https://app.example/api/webhooks/apollo/x' });
    expect(withHook.get('reveal_phone_number')).toBe('true');
    expect(withHook.get('webhook_url')).toBe('https://app.example/api/webhooks/apollo/x');
  });
});

describe('Apollo response', () => {
  it('keeps a verified email and company details', () => {
    const result = parseApolloMatch({
      person: {
        id: 'p1',
        email: 'Mette@Nordlys.dk',
        email_status: 'verified',
        organization: { website_url: 'http://nordlys.dk', industry: 'energy', estimated_num_employees: 120 },
      },
    });
    expect(result.found).toBe(true);
    expect(result.fields).toEqual({
      email: 'mette@nordlys.dk',
      company_website: 'http://nordlys.dk',
      industry: 'energy',
      company_size: '120',
    });
  });

  it.each([
    ['a guessed address', { email: 'mette@nordlys.dk', email_status: 'guessed' }],
    ['a locked placeholder', { email: 'email_not_unlocked@domain.com', email_status: 'verified' }],
  ])('never stores %s', (_label, person) => {
    expect(parseApolloMatch({ person }).fields.email).toBeUndefined();
  });

  it('reports no match honestly', () => {
    expect(parseApolloMatch({ person: null })).toMatchObject({ found: false, fields: {} });
    expect(parseApolloMatch('nonsense').found).toBe(false);
  });

  it('reads phone numbers from a webhook payload, preferring mobile', () => {
    expect(
      parseApolloPhoneWebhook({
        people: [
          {
            id: 'p1',
            phone_numbers: [
              { raw_number: '+45 70 20 30 40', sanitized_number: '+4570203040', type_cd: 'work_hq' },
              { sanitized_number: '+4520304050', type_cd: 'mobile' },
            ],
          },
        ],
      }),
    ).toEqual({ mobile_phone: '+4520304050', phone: '+4570203040' });
    expect(parseApolloPhoneWebhook({ people: [] })).toEqual({});
    expect(parseApolloPhoneWebhook({ phone_numbers: [{ number: 'n/a' }] })).toEqual({});
  });
});

describe('fillEmptyFields', () => {
  it('fills gaps and never overwrites what the lead already has', () => {
    expect(
      fillEmptyFields({ ...lead, email: 'own@typed.dk' } as Lead, {
        email: 'apollo@nordlys.dk',
        mobile_phone: '+4520304050',
        industry: null,
      }),
    ).toEqual({ mobile_phone: '+4520304050' });
  });
});

describe('conversation', () => {
  const sent = [{ body: 'Hej', sent_at: '2026-10-01T09:00:00Z', created_at: '2026-10-01T08:00:00Z' }];
  const replies = [{ body: 'Tak, fortæl mere', received_at: '2026-10-02T10:00:00Z' }];

  it('merges sent messages and replies in time order', () => {
    expect(buildConversation(sent, replies).map((e) => e.from)).toEqual(['sender', 'lead']);
  });

  it('works out what to write next', () => {
    expect(inferKind([])).toBe('initial');
    expect(inferKind(buildConversation(sent, []))).toBe('follow_up');
    expect(inferKind(buildConversation(sent, replies))).toBe('reply');
  });
});

describe('follow-up and reply prompts', () => {
  const facts = {
    full_name: 'Mette Sørensen',
    first_name: 'Mette',
    job_title: 'CFO',
    company_name: 'Nordlys A/S',
    company_website: null,
    location: null,
    country: null,
    industry: null,
    company_size: null,
    notes: null,
  } satisfies LeadFacts;

  it('gives a follow-up the earlier messages and its topic, and forbids repeating them', () => {
    const { system, user } = buildOutreachPrompt({
      lead: facts,
      campaign: null,
      channel: 'direct_message',
      kind: 'follow_up',
      topic: 'Share the Nordic case',
      conversation: [{ from: 'sender', body: 'Hej Mette', at: '2026-10-01T09:00:00Z' }],
    });
    expect(system).toMatch(/This is a follow-up/);
    expect(system).toMatch(/Do not repeat them/);
    expect(user).toContain('Sender: Hej Mette');
    expect(user).toContain('Share the Nordic case');
  });

  it('tells a reply to answer what they wrote without guessing', () => {
    const { system, user } = buildOutreachPrompt({
      lead: facts,
      campaign: null,
      channel: 'direct_message',
      kind: 'reply',
      conversation: [
        { from: 'sender', body: 'Hej Mette', at: '2026-10-01T09:00:00Z' },
        { from: 'lead', body: 'Hvad koster det?', at: '2026-10-02T09:00:00Z' },
      ],
    });
    expect(system).toMatch(/do not guess/);
    expect(user).toContain('Recipient: Hvad koster det?');
    expect(user).toContain('Draft the reply now.');
  });
});

describe('datetime-local helpers', () => {
  it('round-trips a local time', () => {
    const iso = '2026-10-21T07:30:00.000Z';
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
    expect(fromLocalInput('')).toBeNull();
  });
});
