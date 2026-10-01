
// Thin client for Glider's B2B API (https://docs.glider.fi). Server-only: the
// x-api-key must never reach the browser. Callers get typed helpers for just
// the endpoints Afterbook uses; the rest of the API is deliberately not
// wrapped until it's needed.

// B2B tenants all live on Glider's production API (confirmed by Glider: test with
// separate keys, not a separate environment), so a missing GLIDER_API_BASE should
// not silently point at a staging host that doesn't serve this tenant.
const DEFAULT_BASE = 'https://api.glider.fi/v2';

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
  return !!process.env.GLIDER_API_KEY?.trim();
}

const MAX_RETRIES = 3;

type Envelope<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string; details?: string[] } };

async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  // Env values are trimmed: a stray space from a dashboard paste would otherwise
  // make a valid key read as invalid, or a valid URL as a different host.
  const key = process.env.GLIDER_API_KEY?.trim();
  if (!key) throw new GliderError(503, null, 'GLIDER_API_KEY is not set');
  const base = process.env.GLIDER_API_BASE?.trim() || DEFAULT_BASE;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'x-api-key': key, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });
    const json = (await res.json().catch(() => null)) as (Envelope<T> & { message?: string }) | null;
    const errCode = json && json.success === false ? json.error.code : null;

    // Retry only what Glider documents as safe: 429 (honor Retry-After, else
    // exponential backoff with jitter) and API_506 (signature verifier
    // unavailable). The write routes are idempotent on flowId/nonce, so a
    // replay can't double-apply.
    if ((res.status === 429 || errCode === 'API_506') && attempt < MAX_RETRIES) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt + Math.random() * 250;
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 10_000)));
      continue;
    }

    if (res.ok && json && json.success) return json.data;
    if (json && json.success === false) {
      throw new GliderError(res.status, json.error.code, json.error.message, json.error.details);
    }
    throw new GliderError(res.status, null, json?.message || `HTTP ${res.status}`);
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

// --- Enrollment (two-stage, user-signed) -----------------------------------

export interface EnrollSignatureResponse {
  flowId: string;
  accountIndex: string;
  agentAccountId: string;
  accountType: 'ECDSA' | 'ERC1271';
  message: { kind: 'ecdsa'; raw: string } | { kind: 'typed-data'; typedData: unknown };
}

export const enrollSignature = (input: { ownerAccountId: string; strategyId: string; chainIds: number[]; accountType?: 'ECDSA' | 'ERC1271' }) =>
  request<EnrollSignatureResponse>('POST', '/enroll/signature', input);

export interface EnrollInput {
  ownerAccountId: string;
  strategyId: string;
  chainIds: number[];
  accountIndex: string;
  agentAccountId: string;
  signature: string;
  flowId: string;
  portfolioName?: string;
}

export const enroll = (input: EnrollInput) =>
  request<{ portfolioId: string; strategyId: string; smartAccounts: { accountId: string }[] }>('POST', '/enroll', input);

// --- Portfolios -------------------------------------------------------------

export interface GliderPortfolio {
  portfolioId: string;
  portfolioName: string;
  ownerAccountId: string;
  strategyId: string;
  strategyVersion?: number;
  smartAccounts: { accountId: string; depositAccountId?: string }[];
  schedule: { status: 'active' | 'paused'; frequency: string; nextDueAt?: string; lastRebalanceAt?: string };
}

export const listPortfolios = (q: { ownerAccountId: string; strategyId?: string }) => {
  const params = new URLSearchParams({ ownerAccountId: q.ownerAccountId });
  if (q.strategyId) params.set('strategyId', q.strategyId);
  return request<{ portfolios: GliderPortfolio[]; nextCursor: string | null }>('GET', `/portfolios?${params}`);
};

export const getPortfolio = (portfolioId: string) =>
  request<GliderPortfolio>('GET', `/portfolios/${encodeURIComponent(portfolioId)}`);

export const getPositions = (portfolioId: string) =>
  request<unknown>('GET', `/portfolios/${encodeURIComponent(portfolioId)}/positions`);

export const startPortfolio = (portfolioId: string) =>
  request<unknown>('POST', `/portfolios/${encodeURIComponent(portfolioId)}/start`);

// --- Withdrawal (two-stage, user-signed, 10-minute expiry) -------------------

export interface WithdrawSignatureInput {
  recipientAccountId: string;
  assets: { assetId: string; amountRaw: string }[];
  /** Swap the assets into the settlement asset (USDC by default on EVM) first. */
  liquidate?: boolean;
}

export const withdrawSignature = (portfolioId: string, input: WithdrawSignatureInput) =>
  request<{ authorizationId: string; expiresAt: string; typedData: { message: unknown } & Record<string, unknown> }>(
    'POST',
    `/portfolios/${encodeURIComponent(portfolioId)}/withdraw/signature`,
    input,
  );

export const withdraw = (portfolioId: string, input: { message: unknown; signature: string }) =>
  request<{ operationId: string; submittedAt: string }>('POST', `/portfolios/${encodeURIComponent(portfolioId)}/withdraw`, input);

export const getOperation = (portfolioId: string, operationId: string) =>
  request<unknown>('GET', `/portfolios/${encodeURIComponent(portfolioId)}/operations/${encodeURIComponent(operationId)}`);

export const getStrategy = (strategyId: string) =>
  request<{ strategyId: string; version: number; allocation: GliderAllocation }>('GET', `/strategies/${encodeURIComponent(strategyId)}`);
