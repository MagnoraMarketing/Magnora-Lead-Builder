import 'server-only';

import { cvrEnv } from '@/lib/env';

export class CvrRequestError extends Error {
  constructor(
    public readonly code: 'cvr_not_configured' | 'cvr_auth_failed' | 'cvr_rejected' | 'cvr_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'CvrRequestError';
  }
}

/** Sends one Elasticsearch body to the register and returns the parsed JSON. */
export async function cvrSearch(body: Record<string, unknown>): Promise<unknown> {
  const { username, password, endpoint } = cvrEnv();
  if (!username || !password) {
    throw new CvrRequestError('cvr_not_configured', 'CVR access is not set up on this deployment.');
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(25_000),
    });
  } catch (error) {
    console.error('[cvr] request failed', error);
    throw new CvrRequestError('cvr_unavailable', 'The CVR register could not be reached.');
  }

  const raw: unknown = await response.json().catch(() => null);
  if (response.status === 401 || response.status === 403) {
    throw new CvrRequestError('cvr_auth_failed', 'The CVR register rejected the username or password.');
  }
  if (!response.ok) {
    console.error('[cvr] error response', response.status, JSON.stringify(raw)?.slice(0, 2000));
    const reason =
      raw && typeof raw === 'object' && 'error' in raw
        ? JSON.stringify((raw as { error: unknown }).error).slice(0, 300)
        : `HTTP ${response.status}`;
    throw new CvrRequestError(
      response.status >= 500 ? 'cvr_unavailable' : 'cvr_rejected',
      `The CVR register returned an error: ${reason}`,
    );
  }
  return raw;
}

export const CVR_ERROR_STATUS: Record<CvrRequestError['code'], number> = {
  cvr_not_configured: 503,
  cvr_auth_failed: 502,
  cvr_rejected: 502,
  cvr_unavailable: 503,
};
