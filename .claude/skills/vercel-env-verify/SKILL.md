---
name: vercel-env-verify
description: Change a Vercel production environment variable and confirm it actually reached the live site. Use any time an env var is added/updated/removed for the afterbook Vercel project — an env var change alone does not redeploy, so the live site silently keeps serving the old value until this full sequence completes.
---

# Update and verify a Vercel env var

Vercel bakes env vars into a deployment at build/deploy time. Editing a
variable's value (via `vercel env` or the dashboard) does **not**
redeploy anything — the currently-live deployment keeps serving the old
value indefinitely until a new deploy runs. Treat "I updated the env
var" and "the change is live" as two separate, both-required steps.

Production env var changes and `vercel deploy --prod` are gated by this
session's permission model — see the root `CLAUDE.md`. If a `vercel env`
command gets blocked, don't work around it; explain what you were
attempting and let the user either do it via the dashboard or grant the
permission.

## Sequence

1. **Change the value** — via `vercel env rm <NAME> production --yes`
   then `vercel env add <NAME> production` (piping the value directly is
   fine for non-secret values like public addresses; for real secrets,
   have the user do this step in the dashboard). Confirm with
   `vercel env ls production | grep <NAME>` — note the value is hidden,
   this only confirms *a* change happened, not *which* value.

2. **Redeploy** — `vercel deploy --prod`. Check the current production
   deployment's age first (`vercel ls <project> --prod`); if it's older
   than the env change, it's serving stale config and this step is
   required, not optional.

3. **Verify against the live site directly** — don't trust the deploy
   command's success output alone. Hit an endpoint that actually
   surfaces the value:
   ```bash
   curl -s -i https://afterbook.app/api/v1/x402/quote | grep -i "payment-required" \
     | sed 's/payment-required: //' | base64 -d
   ```
   (For `X402_PAYOUT_ADDRESS` specifically, check the decoded `payTo`
   field on all four `/api/v1/x402/*` routes — `quote`, `tape`,
   `history`, `lp-range` — they're independent route handlers, each
   with its own `withX402(...)` call, so each needs to reflect the
   change separately; missing one means it's silently still paying
   out to the old address. Re-count this list if another x402 route
   gets added later.) For a different env var, find an equivalent
   externally-observable signal before declaring the change live.

## Also watch for

Unrelated build breakage surfacing during this sequence isn't
necessarily connected to the env var — e.g. `vercel deploy --prod` once
failed here because of a missing `.vercelignore` letting an unrelated
Foundry `lib/` tree into the Next.js typecheck. Read the actual build
error rather than assuming it's about the env var change.
