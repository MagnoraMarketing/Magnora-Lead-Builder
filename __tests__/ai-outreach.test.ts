/**
 * Exercises lib/ai/outreach.ts through the real Anthropic SDK with only
 * `fetch` stubbed, so the request we send and the response handling are both
 * checked without a network call or an API key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiGenerationError, generateOutreachMessage } from '@/lib/ai/outreach';
import type { OutreachPromptInput } from '@/lib/outreach/prompt';

const input: OutreachPromptInput = {
  lead: {
    full_name: 'Mette Sørensen',
    first_name: 'Mette',
    job_title: 'CFO',
    company_name: 'Nordlys A/S',
    company_website: null,
    location: 'Aarhus',
    country: null,
    industry: null,
    company_size: null,
    notes: null,
  },
  campaign: null,
  channel: 'connection_request',
};

function apiResponse(text: string, stop_reason = 'end_turn', status = 200) {
  const body =
    status === 200
      ? {
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text }],
          stop_reason,
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 10 },
        }
      : { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_test' },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  delete process.env.OUTREACH_AI_MODEL;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
});

async function sentBody(call = 0) {
  const [, init] = fetchMock.mock.calls[call] as [unknown, RequestInit];
  return JSON.parse(String(init.body));
}

function sentHeaders(call = 0): Headers {
  const [, init] = fetchMock.mock.calls[call] as [unknown, RequestInit];
  return new Headers(init.headers);
}

describe('generateOutreachMessage', () => {
  it('sends a structured-output request with refusal fallbacks and returns the draft', async () => {
    fetchMock.mockResolvedValueOnce(apiResponse('{"message":"Hej Mette, lad os forbinde."}'));

    const result = await generateOutreachMessage(input);
    expect(result).toEqual({ body: 'Hej Mette, lad os forbinde.', model: 'claude-opus-5-5' });

    const body = await sentBody();
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.output_config.effort).toBe('low');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.fallbacks).toBe('default');
    expect(body).not.toHaveProperty('thinking');
    expect(sentHeaders().get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(sentHeaders().get('x-api-key')).toBe('sk-test');
  });

  it('omits fallbacks for a model that does not support them', async () => {
    process.env.OUTREACH_AI_MODEL = 'claude-haiku-5-5';
    fetchMock.mockResolvedValueOnce(apiResponse('{"message":"Hej Mette"}'));
    await generateOutreachMessage(input);
    const body = await sentBody();
    expect(body.model).toBe('claude-haiku-5-5');
    expect(body).not.toHaveProperty('fallbacks');
  });

  it('retries once with feedback when the draft breaks a rule', async () => {
    fetchMock
      .mockResolvedValueOnce(apiResponse('{"message":"Hej [Name], lad os forbinde."}'))
      .mockResolvedValueOnce(apiResponse('{"message":"Hej Mette, lad os forbinde."}'));

    const result = await generateOutreachMessage(input);
    expect(result.body).toBe('Hej Mette, lad os forbinde.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await sentBody(1)).messages[0].content).toContain('placeholder');
  });

  it('gives up with ai_invalid_output after repeated bad drafts', async () => {
    fetchMock.mockImplementation(async () => apiResponse(`{"message":"${'a'.repeat(400)}"}`));
    await expect(generateOutreachMessage(input)).rejects.toMatchObject({
      code: 'ai_invalid_output',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reports a refusal instead of saving anything', async () => {
    fetchMock.mockResolvedValueOnce(apiResponse('', 'refusal'));
    await expect(generateOutreachMessage(input)).rejects.toMatchObject({ code: 'ai_refused' });
  });

  it('maps a rejected API key to ai_auth_failed without retrying', async () => {
    fetchMock.mockResolvedValue(apiResponse('', 'end_turn', 401));
    const error = await generateOutreachMessage(input).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiGenerationError);
    expect((error as AiGenerationError).code).toBe('ai_auth_failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to run without an API key', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(generateOutreachMessage(input)).rejects.toMatchObject({
      code: 'ai_not_configured',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
