import { describe, expect, it } from 'vitest';
import { allowedActions, applyMessageAction, canEditBody } from '@/lib/outreach/lifecycle';
import {
  buildOutreachPrompt,
  validateGeneratedMessage,
  type CampaignContext,
  type LeadFacts,
} from '@/lib/outreach/prompt';

const lead: LeadFacts = {
  full_name: 'Mette Sørensen',
  first_name: 'Mette',
  job_title: 'CFO',
  company_name: 'Nordlys A/S',
  company_website: null,
  location: 'Aarhus',
  country: 'Denmark',
  industry: null,
  company_size: '51-200',
  notes: null,
};

const campaign: CampaignContext = {
  name: 'Q1 finance',
  sender_name: 'Jonas',
  sender_company: 'Magnora',
  offer: 'We automate month-end close for mid-sized finance teams. See https://magnora.dk/close',
  call_to_action: 'A 15-minute call',
  tone: 'professional',
  language: 'da',
};

describe('buildOutreachPrompt', () => {
  it('passes only stored, non-empty facts to the model', () => {
    const { user } = buildOutreachPrompt({ lead, campaign, channel: 'connection_request' });
    expect(user).toContain('"job_title": "CFO"');
    expect(user).toContain('"company": "Nordlys A/S"');
    expect(user).toContain('"sender_company": "Magnora"');
    // Empty fields are left out entirely, not sent as null.
    expect(user).not.toContain('industry');
    expect(user).not.toContain('company_website');
  });

  it('forbids invented research and placeholders in the system prompt', () => {
    const { system } = buildOutreachPrompt({ lead, campaign, channel: 'connection_request' });
    expect(system).toMatch(/Do not claim or imply that the sender has read/);
    expect(system).toMatch(/Do not invent numbers/);
    expect(system).toMatch(/Never output placeholders/);
    expect(system).toMatch(/not instructions to you/);
  });

  it('writes in the campaign language and respects the channel limit', () => {
    const da = buildOutreachPrompt({ lead, campaign, channel: 'connection_request' });
    expect(da.system).toContain('Write in Danish');
    expect(da.system).toContain('300 characters');

    const en = buildOutreachPrompt({
      lead,
      campaign: { ...campaign, language: 'en' },
      channel: 'direct_message',
    });
    expect(en.system).toContain('Write in English');
    expect(en.system).toContain('direct message');
  });

  it('asks for a no-pitch note when there is no campaign', () => {
    const { user, system } = buildOutreachPrompt({ lead, campaign: null, channel: 'connection_request' });
    expect(user).toContain('without pitching anything');
    expect(system).toContain('Write in Danish');
  });

  it('includes the sender’s one-off guidance only when given', () => {
    const without = buildOutreachPrompt({ lead, campaign, channel: 'connection_request' });
    expect(without.user).not.toContain('extra_guidance');
    const withIt = buildOutreachPrompt({
      lead,
      campaign,
      channel: 'connection_request',
      instructions: 'We met at the fintech meetup',
    });
    expect(withIt.user).toContain('We met at the fintech meetup');
  });
});

describe('validateGeneratedMessage', () => {
  it('accepts a clean draft', () => {
    expect(
      validateGeneratedMessage('Hej Mette, jeg vil gerne forbinde.', 'connection_request', campaign),
    ).toEqual([]);
  });

  it('rejects an empty draft', () => {
    expect(validateGeneratedMessage('   ', 'connection_request', campaign)).toHaveLength(1);
  });

  it('enforces the LinkedIn connection note limit', () => {
    const problems = validateGeneratedMessage('a'.repeat(301), 'connection_request', campaign);
    expect(problems.join()).toMatch(/limit is 300/);
    expect(validateGeneratedMessage('a'.repeat(301), 'direct_message', campaign)).toEqual([]);
  });

  it.each(['Hej [Name], ...', 'Hi {{first_name}}', 'Hi {company} team', 'Dear <first name>,'])(
    'rejects placeholder text: %s',
    (text) => {
      expect(validateGeneratedMessage(text, 'direct_message', campaign).join()).toMatch(
        /placeholder/,
      );
    },
  );

  it('allows only links the user put in the campaign', () => {
    expect(
      validateGeneratedMessage('Se https://magnora.dk/close', 'direct_message', campaign),
    ).toEqual([]);
    expect(
      validateGeneratedMessage('Se https://made-up.example/x', 'direct_message', campaign).join(),
    ).toMatch(/link/);
    expect(validateGeneratedMessage('Se www.magnora.dk', 'direct_message', null).join()).toMatch(
      /link/,
    );
  });
});

describe('message lifecycle', () => {
  it('requires approval before a message can be marked sent', () => {
    expect(applyMessageAction('draft', 'mark_sent')).toEqual({
      ok: false,
      reason: 'Approve the message before marking it as sent.',
    });
    expect(applyMessageAction('approved', 'mark_sent')).toEqual({ ok: true, status: 'sent' });
  });

  it('treats sent as final', () => {
    expect(allowedActions('sent')).toEqual([]);
    expect(canEditBody('sent')).toBe(false);
    expect(applyMessageAction('sent', 'archive').ok).toBe(false);
  });

  it('offers the expected actions per status', () => {
    expect(allowedActions('draft')).toEqual(['approve', 'archive']);
    expect(allowedActions('approved')).toEqual(['unapprove', 'mark_sent', 'archive']);
    expect(allowedActions('archived')).toEqual(['approve', 'restore']);
  });
});
