import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { aiEnv } from '@/lib/env';
import {
  OUTREACH_OUTPUT_JSON_SCHEMA,
  buildOutreachPrompt,
  validateGeneratedMessage,
  type OutreachPromptInput,
} from '@/lib/outreach/prompt';

/**
 * Server-side message drafting with the Anthropic API.
 *
 * The API key is read from the server environment and never leaves it: the
 * browser only ever talks to /api/messages/generate, which calls this.
 */

/** Models that accept the server-side refusal fallback parameter. */
const FALLBACK_CAPABLE_MODELS = new Set([
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-fable-5-1',
  'claude-sonnet-5-5',
]);

/** Generation attempts before giving up; the second carries the first's problems. */
const MAX_ATTEMPTS = 2;

const generatedMessageSchema = z.object({ message: z.string() });

export type AiErrorCode =
  | 'ai_not_configured'
  | 'ai_auth_failed'
  | 'ai_rate_limited'
  | 'ai_unavailable'
  | 'ai_refused'
  | 'ai_invalid_output';

export class AiGenerationError extends Error {
  constructor(
    public readonly code: AiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AiGenerationError';
  }
}

export interface GeneratedMessage {
  body: string;
  model: string;
}

export async function generateOutreachMessage(
  input: OutreachPromptInput,
): Promise<GeneratedMessage> {
  const { apiKey, model } = aiEnv();
  if (!apiKey) {
    throw new AiGenerationError(
      'ai_not_configured',
      'AI drafting is not set up on this deployment. Add ANTHROPIC_API_KEY to the server environment.',
    );
  }

  const client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 });
  const prompt = buildOutreachPrompt(input);
  const fallback = FALLBACK_CAPABLE_MODELS.has(model)
    ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
    : {};

  let feedback: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const userContent =
      feedback.length === 0
        ? prompt.user
        : `${prompt.user}\n\nYour previous draft was rejected for these reasons:\n- ${feedback.join('\n- ')}\nWrite a new draft that fixes them.`;

    let response;
    try {
      // create() rather than parse(): parse() throws on the empty body of a
      // refusal before stop_reason can be checked, so the JSON is parsed below.
      response = await client.beta.messages.create({
        model,
        max_tokens: 8000,
        // Short creative writing: low effort keeps latency and cost down.
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: { ...OUTREACH_OUTPUT_JSON_SCHEMA } },
        },
        system: prompt.system,
        messages: [{ role: 'user', content: userContent }],
        ...fallback,
      });
    } catch (error) {
      throw toAiError(error);
    }

    if (response.stop_reason === 'refusal') {
      throw new AiGenerationError(
        'ai_refused',
        'The AI declined to draft this message. Write it by hand instead.',
      );
    }

    const text = response.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('');
    const parsed = generatedMessageSchema.safeParse(parseJson(text));
    if (response.stop_reason === 'max_tokens' || !parsed.success) {
      feedback = ['The response was cut off or was not in the requested format.'];
      continue;
    }

    const body = parsed.data.message.trim();
    const problems = validateGeneratedMessage(body, input.channel, input.campaign);
    if (problems.length === 0) {
      return { body, model: response.model };
    }
    feedback = problems;
  }

  console.error('[ai:outreach] draft rejected after retries', feedback);
  throw new AiGenerationError(
    'ai_invalid_output',
    'The AI could not produce a draft that passed the checks. Try again or write it by hand.',
  );
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Maps SDK errors to stable codes. Details go to the server log, not the client. */
function toAiError(error: unknown): AiGenerationError {
  console.error('[ai:outreach] request failed', error);
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AiGenerationError(
      'ai_auth_failed',
      'The AI provider rejected the server’s API key. Check ANTHROPIC_API_KEY.',
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    return new AiGenerationError(
      'ai_rate_limited',
      'The AI provider is rate limiting requests. Wait a minute and try again.',
    );
  }
  return new AiGenerationError(
    'ai_unavailable',
    'The AI provider could not be reached. Try again shortly.',
  );
}
