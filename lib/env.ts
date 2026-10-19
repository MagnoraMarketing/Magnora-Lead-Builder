/**
 * Environment access, split by trust boundary.
 *
 * `publicEnv` is safe in the browser. `serverEnv()` reads the service role key
 * and throws if it is called anywhere a bundler could reach — the guard is a
 * runtime backstop for the naming convention, not a replacement for it.
 */

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/**
 * The browser key. Supabase now issues a publishable key (`sb_publishable_…`)
 * in place of the legacy anon JWT; both play the same role, so either name is
 * accepted and the publishable key wins when both are set. Each is referenced
 * literally so Next.js can inline it into the client bundle.
 */
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey:
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    '',
};

export function requirePublicEnv() {
  return {
    supabaseUrl: required('NEXT_PUBLIC_SUPABASE_URL', publicEnv.supabaseUrl),
    supabaseAnonKey: required('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', publicEnv.supabaseAnonKey),
  };
}

export function serverEnv() {
  if (typeof window !== 'undefined') {
    throw new Error('serverEnv() must never be called in the browser.');
  }
  return {
    supabaseUrl: required('NEXT_PUBLIC_SUPABASE_URL', process.env.NEXT_PUBLIC_SUPABASE_URL),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY', process.env.SUPABASE_SERVICE_ROLE_KEY),
  };
}

/**
 * The three variables the app cannot run without, in the order the setup page
 * lists them.
 *
 * The service role key belongs here even though only the rate limiter reads
 * it. Leaving it out meant a deployment with two of the three variables set
 * booted and signed users in as if it were healthy, while `checkRateLimit`
 * threw on every call and failed open — so the app quietly ran with no rate
 * limiting at all and nothing on screen said so.
 */
export const REQUIRED_SUPABASE_ENV = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
] as const;

export type RequiredSupabaseEnv = (typeof REQUIRED_SUPABASE_ENV)[number];

/**
 * Names of the required variables that are unset or empty.
 *
 * Server-side only: the two `NEXT_PUBLIC_` values are inlined at build time and
 * so read correctly anywhere, but `SUPABASE_SERVICE_ROLE_KEY` is only present
 * in a server process. Calling this in the browser would always report it
 * missing, so it refuses instead of reporting something false.
 */
export function missingSupabaseEnv(): RequiredSupabaseEnv[] {
  if (typeof window !== 'undefined') {
    throw new Error('missingSupabaseEnv() must never be called in the browser.');
  }
  const values: Record<RequiredSupabaseEnv, string | undefined> = {
    NEXT_PUBLIC_SUPABASE_URL: publicEnv.supabaseUrl,
    // Satisfied by the legacy NEXT_PUBLIC_SUPABASE_ANON_KEY too; see publicEnv.
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publicEnv.supabaseAnonKey,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  };
  return REQUIRED_SUPABASE_ENV.filter((name) => !values[name]);
}

/** True when Supabase is configured. Used to show a setup screen instead of crashing. */
export function isSupabaseConfigured(): boolean {
  return missingSupabaseEnv().length === 0;
}

/** Used when OUTREACH_AI_MODEL is unset. */
export const DEFAULT_OUTREACH_AI_MODEL = 'claude-opus-5-5';

/**
 * Optional AI configuration for drafting outreach messages.
 *
 * Server-only, like the service role key: the Anthropic API key must never be
 * given a NEXT_PUBLIC_ prefix. Missing is a supported state — the app runs,
 * and the generate endpoint answers `ai_not_configured` instead of failing.
 */
export function aiEnv(): { apiKey: string | null; model: string } {
  if (typeof window !== 'undefined') {
    throw new Error('aiEnv() must never be called in the browser.');
  }
  return {
    apiKey: process.env.ANTHROPIC_API_KEY || null,
    model: process.env.OUTREACH_AI_MODEL || DEFAULT_OUTREACH_AI_MODEL,
  };
}

export function isAiConfigured(): boolean {
  return aiEnv().apiKey !== null;
}

/**
 * Optional contact enrichment with Apollo.io. Server-only.
 *
 * Phone numbers arrive at a webhook, so they are only requested when the app
 * knows its own public URL: APP_URL, or the production domain Vercel exposes.
 * VERCEL_AUTOMATION_BYPASS_SECRET is set by Vercel when "Protection Bypass for
 * Automation" is enabled, and lets Apollo past Vercel Authentication.
 */
export function enrichmentEnv(): {
  apolloApiKey: string | null;
  publicUrl: string | null;
  bypassSecret: string | null;
} {
  if (typeof window !== 'undefined') {
    throw new Error('enrichmentEnv() must never be called in the browser.');
  }
  const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const publicUrl = process.env.APP_URL || (productionHost ? `https://${productionHost}` : '');
  return {
    apolloApiKey: process.env.APOLLO_API_KEY || null,
    publicUrl: publicUrl ? publicUrl.replace(/\/+$/, '') : null,
    bypassSecret: process.env.VERCEL_AUTOMATION_BYPASS_SECRET || null,
  };
}

/**
 * The Danish company register (CVR), system-to-system access. Server-only.
 *
 * Free, but personal: request credentials from Erhvervsstyrelsen
 * (cvrselvbetjening@erst.dk). CVR_ENDPOINT only needs setting if the register
 * moves its search URL.
 */
export const DEFAULT_CVR_ENDPOINT = 'http://distribution.virk.dk/cvr-permanent/virksomhed/_search';

export function cvrEnv(): { username: string | null; password: string | null; endpoint: string } {
  if (typeof window !== 'undefined') {
    throw new Error('cvrEnv() must never be called in the browser.');
  }
  return {
    username: process.env.CVR_USERNAME || null,
    password: process.env.CVR_PASSWORD || null,
    endpoint: process.env.CVR_ENDPOINT || DEFAULT_CVR_ENDPOINT,
  };
}

export function isCvrConfigured(): boolean {
  const env = cvrEnv();
  return Boolean(env.username && env.password);
}
