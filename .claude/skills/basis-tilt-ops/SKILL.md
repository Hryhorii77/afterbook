---
name: basis-tilt-ops
description: Operate the Basis Tilt basket on Glider safely — check who is enrolled and what they hold, dry-run the weight update, publish a new strategy version by hand, create a private test strategy, and diagnose Glider API errors. Use before ANY write to Glider (publish, rebalance, strategy settings) and when the user asks about the live basket's weights or health. Real money; read the rules first.
---

# Basis Tilt operations (Glider, real money)

Background: `README.md` → "Baskets (Basis Tilt)". Code: `lib/glider.ts`
(client), `lib/baskets/{weights,tilt,update,guard}.ts`,
`app/api/baskets/*`, `app/api/cron/basket-tilt/route.ts`.

## Rules (also in `CLAUDE.md`)

1. **Glider's B2B API is production-only.** The key is a production tenant
   key; every write is real. There is no staging (`staging-api.glider.fi`
   rejects the key).
2. **Publishing a strategy version makes every enrolled portfolio
   rebalance to it.** Never publish, trigger a rebalance
   (`POST /portfolios/{id}/rebalance`), change strategy settings, or
   submit a withdrawal unless the user told you to in this turn — and for
   a publish, only after step 1 below.
3. **The permission classifier may block real-money calls** (a manual
   rebalance trigger was blocked once). Don't route around a denial:
   explain what you were doing and give the user the command to run
   themselves (`!` prefix runs it as them).
4. `BASKET_AUTOPUBLISH` stays unset unless the user decides otherwise.
5. Never print, log or paste `GLIDER_API_KEY`. Run scripts with
   `.env.local` loaded (`set -a; . ./.env.local; set +a`) and print only
   counts, ids and weights. The local key is read-only (see "API keys").
6. The live strategy is `GLIDER_STRATEGY_ID` in Vercel Production.
   `.env.local` may hold a **test** strategy id in `GLIDER_STRATEGY_ID`
   and the real one in `GLIDER_STRATEGY_ID_MAIN` — check which you are
   about to touch.

## API keys (rotated 2026-10-02)

There are **two keys**, both for the same production tenant:

| Key | Lives in | Scopes |
| --- | --- | --- |
| `afterbook-vercel-prod` | Vercel Production only (Sensitive) | `strategies:read`, `strategies:write`, `enroll:write`, `portfolios:read`, `portfolios:write`, `portfolios:withdraw` |
| `afterbook-dev-local` | `.env.local` | `strategies:read`, `portfolios:read`, `enroll:write` |

- **The local key is read-only on purpose.** Dry runs, reads and testing the
  enroll panel work. Anything that writes (publishing a version, `start`,
  strategy settings, withdrawals) is refused locally with a 403 — that is
  the safety net, not a bug. Don't ask the user to widen the dev key.
- **To publish by hand**, the user runs the script in **their own
  terminal** with a write-capable key held only for that one command
  (never stored, never pasted to the assistant), e.g.
  `read -rs GLIDER_API_KEY; export GLIDER_API_KEY; npx tsx ./tmp-publish.ts; unset GLIDER_API_KEY`
  (use the key `afterbook-vercel-prod` if they are comfortable creating a
  short-lived one; otherwise create a temporary write key in the console
  and revoke it afterwards). The assistant prepares and checks the plan
  (steps 1–2) and hands over the command.
- **Glider's API cannot create, list or revoke keys** (32 endpoints, none
  for keys; only `GET /scopes` and `GET /whoami`). Creating and revoking is
  console-only (console.glidercloud.dev).
- **Rotation procedure** (keeps the live site working throughout): create
  the new key(s) in the console → put the production key into Vercel with a
  hidden prompt (`vercel env rm` then `printf '%s' "$KEY" | vercel env add
  GLIDER_API_KEY production --sensitive`; confirm with `vercel env ls
  production`) → redeploy → check the live site → put the dev key in
  `.env.local` with a hidden prompt and a script that strips stray
  spaces/`<` `>` → check it with `GET /whoami` (prints tenant, `apiKeyId`
  and scopes, never the key) → **only then revoke the old key** → re-check
  live: if it still works, it is on the new key. Never type a key into the
  assistant session or a command line (shell history).

Scripts below import repo modules, so write them as `tmp-*.ts` in the
**repo root**, run with `npx tsx ./tmp-x.ts`, and **delete them
afterwards**. Don't commit them.

## 1. Who is enrolled and what do they hold? (read-only, always first)

```ts
import { getStrategy } from './lib/glider';
const base = (process.env.GLIDER_API_BASE ?? 'https://api.glider.fi/v2').trim();
const key = process.env.GLIDER_API_KEY!.trim();
const get = async (p: string) => (await fetch(base + p, { headers: { 'x-api-key': key } })).json();
(async () => {
  const id = process.env.GLIDER_STRATEGY_ID_MAIN!.trim();       // the LIVE strategy
  const s = await getStrategy(id);
  const ps = (await get(`/portfolios?strategyId=${id}&limit=200`)).data?.portfolios ?? [];
  console.log('version', s.version, '| assets', s.allocation.assets.length, '| enrolled', ps.length);
  for (const p of ps) {
    const pos = (await get(`/portfolios/${p.portfolioId}/positions`)).data;
    console.log(p.portfolioId, 'owner …' + p.ownerAccountId.slice(-6), p.schedule.status, '| $' + pos.totalValueUsd, '| inTransit', pos.inTransit?.items?.length);
  }
})();
```

Decision rule: if every enrolled portfolio holds ~$0 (or only the
owner's own test money), a publish moves no one's money. Otherwise stop
and tell the user how many people and how much value are affected before
doing anything.

## 2. Dry-run the update (read-only)

```ts
import { getTape } from './lib/tape';
import { planTiltUpdate } from './lib/baskets/update';
(async () => {
  const plan = await planTiltUpdate(process.env.GLIDER_STRATEGY_ID_MAIN!.trim(), await getTape());
  console.log('blocked:', plan.blocked, '| publish:', plan.publish, '|', plan.reason);
  console.log(plan.weights.map((w) => `${w.symbol} ${w.weight}`).join(', '));
})();
```

Or `curl -H "Authorization: Bearer $CRON_SECRET" "<host>/api/cron/basket-tilt?dry=1"`
(the deployed route uses the deployed `GLIDER_STRATEGY_ID`).

- `blocked: strategy asset list does not match the tracked stocks` means
  the strategy's assets aren't exactly `BASKET_SYMBOLS` — usually you
  pointed at the test strategy, or someone edited it. Don't force it.
- `publish: false … below 10%` is the smoothing gate working: the live
  weights are already close to the target.
- The first run after a publish has no stored moving average unless the
  publish also saved one (step 3).

## 3. Publish a new version by hand (only when told to, after step 1)

Write the new weights through the same path the cron uses so the moving
average is saved too, but with an accurate change log:

```ts
import { getTape } from './lib/tape';
import { planTiltUpdate } from './lib/baskets/update';
import { assetIdFor } from './lib/baskets/tilt';
import { publishStrategyVersion, getStrategy } from './lib/glider';
import { redis } from './lib/redis';
(async () => {
  const id = process.env.GLIDER_STRATEGY_ID_MAIN!.trim();
  const plan = await planTiltUpdate(id, await getTape());
  if (plan.blocked || !plan.publish) { console.log('NOT publishing:', plan.blocked ?? plan.reason); return; }
  if (plan.weights.reduce((s, w) => s + w.weightHundredths, 0) !== 10_000) throw new Error('weights do not sum to 100');
  const out = await publishStrategyVersion(id, { assets: plan.weights.map((w) => ({ assetId: assetIdFor(w.symbol), weight: w.weight })) }, 'Manual refresh to the current target.');
  await redis?.set(`basket:ema:${id}`, plan.ema);     // key format lives in lib/baskets/update.ts
  console.log('published v' + out.version, (await getStrategy(id)).allocation.assets.map((a) => a.weight).join(' '));
})();
```

Versions are immutable and a new one is live immediately. To undo,
publish the previous version's allocation as a *new* version (read it
with `GET /strategies/{id}`/the versions list) — there is no delete.

## 4. Auto-publish

The daily job publishes by itself only when `BASKET_AUTOPUBLISH=1` in Vercel
Production; `GET /api/cron/basket-tilt?dry=1` (cron bearer) shows the plan and
`autopublishEnabled` (whether the switch is on) without writing anything. Every
publish makes every enrolled portfolio trade, so:

- **The threshold is 10% turnover** (`MIN_TURNOVER` in `lib/baskets/weights.ts`).
  Evidence (2026-10-07, a replay of 19 days of stored history through the same
  rules, depth held at today's level, so approximate): 5% would have published
  about 10 to 12 times (2 days in 3, roughly 90 bp a month at ~0.9% cost per
  unit of basket moved); 10% about 3 (~50 bp); 15% about 1 (~23 bp). Don't lower
  it without redoing that replay (script idea: `computeTiltWeights` +
  `smoothWeights` over `getHistory` samples at 22:00 UTC; see git history of
  this file for the sweep).
- **Dry runs were misleading before 2026-10-07:** the job didn't save the moving
  average unless it published, so a dry run showed one step from a stale
  average. Scheduled runs now save it even with the switch off; `?dry=1` still
  writes nothing. **Never call the endpoint without `?dry=1` from a local
  machine:** `.env.local` shares production's Redis, so it would write the real
  moving average (and could publish if the switch is on).
- **Each publish sends a Telegram message** to `TELEGRAM_ADMIN_CHAT_ID`
  ("Basis Tilt vN published (reason) ... largest weights ..."). If a publish
  happens that the owner didn't expect, check that message and the strategy's
  version list; undo = publish the previous allocation as a new version.
- Turn it off by unsetting `BASKET_AUTOPUBLISH` (see the `vercel-env-verify`
  skill: change, redeploy, verify).

## 5. A private test strategy (to try things without touching the real one)

```ts
import { createStrategy } from './lib/glider';
import { assetIdFor } from './lib/baskets/tilt';
createStrategy({
  name: 'Afterbook Basis Tilt (test, 3 tokens)',
  allocation: { assets: [['NVDAc', '33.34'], ['AMZNc', '33.33'], ['GOOGLc', '33.33']].map(([s, w]) => ({ assetId: assetIdFor(s), weight: w })) },
  schedule: { type: 'interval', frequency: 'daily' },
  preferences: { swap: { slippageBps: 100, priceImpactBps: 100, thresholdUsd: '1.00' } },
  isPublic: false,
}).then((r) => console.log(r.strategyId));
```

Use the deepest pools, keep it private, and size tests so each position
is at least $1 (Glider's minimum swap, `thresholdUsd` cannot be below
`1.00`). Measured: a ~$5 round trip through three liquid names cost about
0.9% in swaps; a USDC-only deposit and withdrawal costs nothing.
`POST /v2/strategies/validate` is a dry run with no side effects.

## Glider API cheat sheet

- Envelope: `{success, data}` or `{success:false, error:{code,message,details}}`.
- `API_102` invalid key — wrong host (staging) or a malformed value
  (placeholders, spaces). `API_104` missing scope — see `GET /whoami`.
- `API_400 Strategy not found or not owned by tenant: <id>` with spaces
  in the id — a bad env value (the client trims now).
- `API_004` / 429 on rebalance — a rebalance finished too recently
  (cooldown); in our test the first scheduled rebalance ran about a minute
  after enrollment, so a manual trigger right after is usually refused.
- Async work returns `202` with an `operationId`; poll
  `GET /portfolios/{id}/operations/{operationId}` until `completed`,
  `failed` or `cancelled`. Operation ids are not all one shape.
- Withdrawal authorizations expire after 10 minutes; enrollment `flowId`
  after 24 hours; both are idempotency anchors — replay, don't recreate.
- Rate limits are per IP (all Vercel requests share IPs); the app's own
  limiter is 20 requests/min/IP on `/api/baskets/*`.
