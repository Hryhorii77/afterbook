
// Thin client for Glider's B2B API (https://docs.glider.fi). Server-only: the
// x-api-key must never reach the browser. Callers get typed helpers for just
// the endpoints Afterbook uses; the rest of the API is deliberately not
// wrapped until it's needed.

const DEFAULT_BASE = 'https://staging-api.glider.fi/v2';

export interface GliderAllocation {
  assets: { assetId: string; weight: string }[];
}

export interface GliderStrategyInput {
  name: string;
  description?: string;
  allocation: GliderAllocation;
  schedule: { type: 'interval'; frequency: 'daily' | 'weekly' };
  preferences?: { swap?: { slippageBps?: number; priceImpactBps?: number; thresholdUsd?: string } };
  isPublic?: boolean;
}

export class GliderError extends Error {
  constructor(
    public status: number,
    public code: string | null,
    message: string,
    public details: string[] = [],
  ) {
    super(message);
  }
}

export function gliderConfigured(): boolean {
  return !!process.env.GLIDER_API_KEY;
}

const MAX_RETRIES = 3;

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const key = process.env.GLIDER_API_KEY;
  if (!key) throw new GliderError(503, null, 'GLIDER_API_KEY is not set');
  const base = process.env.GLIDER_API_BASE ?? DEFAULT_BASE;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });

    // 429: honor Retry-After, else exponential backoff with jitter. 503 with
    // API_506 (signature verifier down) is documented as safe to retry.
    if ((res.status === 429 || res.status === 503) && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt + Math.random() * 250;
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 10_000)));
      continue;
    }

    const json = (await res.json().catch(() => null)) as
      | { success: true; data: T }
      | { success: false; error: { code: string; message: string; details?: string[] } }
      | { error?: string; message?: string }
      | null;

    if (res.ok && json && 'success' in json && json.success) return json.data;
    if (json && 'success' in json && json.success === false) {
      throw new GliderError(res.status, json.error.code, json.error.message, json.error.details);
    }
    throw new GliderError(res.status, null, (json && 'message' in json && json.message) || `HTTP ${res.status}`);
  }
}

export interface WhoAmI {
  tenantName: string;
  tenantEmail: string;
  apiKeyId: string;
  scopes: string[];
}

export const whoami = () => request<WhoAmI>('GET', '/whoami');

/** Dry run — no side effects. Also the cheapest way to learn whether Glider
 *  recognises the B20 token asset ids. Needs strategies:write. */
export const validateStrategy = (s: GliderStrategyInput) =>
  request<{ valid: boolean }>('POST', '/strategies/validate', s);

export const createStrategy = (s: GliderStrategyInput) =>
  request<{ strategyId: string; version: number }>('POST', '/strategies', s);

/** Goes live immediately for every enrolled portfolio on its next run. */
export const publishStrategyVersion = (strategyId: string, allocation: GliderAllocation, changeLog?: string) =>
  request<{ version: number }>('POST', `/strategies/${strategyId}/versions`, { allocation, ...(changeLog ? { changeLog } : {}) });
