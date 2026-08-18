# Store publish automation — handoff

State of `explore/store-publish-automation` (commit `24ba6f4`) as of
2026-08-18, and what remains to finish. Background and rationale:
[`docs/release-automation.md`](release-automation.md) on the same branch.

## What's already done

- **Zero-dependency publishers** — `scripts/publish-chrome.ts` (Chrome Web
  Store API **v2**, service-account auth; v1 is EOL 2026-10-15) and
  `scripts/publish-firefox.ts` (AMO REST v5). Node built-ins only; verified by
  `pnpm typecheck`, `pnpm test`, and credential-less smoke runs.
- **Workflow** — `.github/workflows/publish-stores.yml`: manual dispatch +
  auto-after-Release (gated on the `STORE_PUBLISH_AUTOMATION` repo variable),
  downloads the release zips (no rebuild), re-verifies the zip's manifest
  version against the tag, submits both stores. Jobs sit in a `stores`
  environment so a required reviewer can be attached.
- **Design doc** — comparison against marketplace actions, setup
  walkthroughs, runbook: `docs/release-automation.md`.

## Blocked on: org policy blocks the service-account key

`iam.disableServiceAccountKeyCreation` is enforced on the resolvr.io Google
organization (Secure by Default), so **Keys → Add key → JSON** fails at the
second setup step. A project cannot override an org-level enforced boolean;
the fix is administrative. Guide to hand the org admin:

1. **Tags** (`console.cloud.google.com/tags`, org selected): create key
   `disableServiceAccountKeyCreation` with values `enforced` / `not_enforced`.
2. Attach `enforced` to the organization; attach `not_enforced` to the Apogee
   publishing project.
3. **IAM & Admin → Organization Policies** (org scope must be selected in the
   top-bar picker) → *Disable service account key creation* → **Manage
   policy**, rules in order (first match wins):

   ```yaml
   name: organizations/ORG_ID/policies/iam.disableServiceAccountKeyCreation
   spec:
     rules:
     - enforce: false
       condition:
         title: exempt tagged projects
         expression: resource.matchTag('ORG_ID/disableServiceAccountKeyCreation', 'not_enforced')
     - enforce: true
   ```

   Blunt alternative (org-wide, weaker posture):
   `gcloud resource-manager org-policies disable-enforcement iam.disableServiceAccountKeyCreation --organization=ORG_ID`

   Roles needed: `resourcemanager.tagAdmin` + `orgpolicy.policyAdmin`.
   Propagation takes a few minutes after saving.

If the admin refuses the exemption, the documented fallback is Workload
Identity Federation (GitHub Actions OIDC impersonates the service account, no
key file) — it changes the console steps and needs a small script/workflow
extension; nothing exists on the branch for it yet. A personal (non-org)
Cloud project is ruled out.

## Remaining steps

1. **Unblock the key** (admin action above), then finish CWS setup:
   download the service-account JSON; add the service-account email under the
   [CWS Developer Dashboard](https://chrome.google.com/webstore/devconsole) →
   Account; note the publisher ID and the item ID.
2. **AMO** (not blocked): [addons.mozilla.org/developers/addon/api/key/](https://addons.mozilla.org/developers/addon/api/key/)
   → generate key + secret (set an expiry; the secret shows once); note the
   listing slug.
3. **GitHub → Settings → Secrets and variables → Actions:**

   | Where | Name | Value |
   | ----- | ---- | ----- |
   | Secret | `CWS_SERVICE_ACCOUNT_JSON` | full service-account key JSON |
   | Secret | `AMO_API_KEY` | AMO JWT issuer |
   | Secret | `AMO_API_SECRET` | AMO JWT secret |
   | Variable | `CWS_PUBLISHER_ID` | publisher ID |
   | Variable | `CWS_ITEM_ID` | extension item ID |
   | Variable | `AMO_ADDON_SLUG` | listing slug |

4. **Rehearse:** Actions → *Publish to stores* → Run workflow → this branch →
   leave the tag empty, **tick draft**. Chrome uploads a discardable draft.
   The firefox job submits for real (AMO has no draft) — cancel it unless a
   real submission is intended.
5. **Go live:** merge the branch, set `STORE_PUBLISH_AUTOMATION=true`; every
   future `v*` tag then publishes GitHub + both stores end-to-end.

Until step 5 the workflow is inert by design: the auto-path checks the
variable, and manual runs fail fast with a pointer to the docs if a secret is
missing.
