# Store publish automation

Publishing a release to the Chrome Web Store and AMO by hand is two dashboard
uploads done minutes after `release.yml` has already built, zipped, and
published the exact same artifacts to GitHub. `publish-stores.yml` closes that
gap: after a Release completes, it downloads the release zips and submits them
to both stores. No rebuild — the stores review bit-for-bit what the GitHub
Release shipped.

## Design: zero dependencies

The publish path is two small scripts (`scripts/publish-chrome.ts`,
`scripts/publish-firefox.ts`) using only Node built-ins, driven by a workflow
that needs nothing beyond `actions/checkout` and `actions/setup-node` (both
already SHA-pinned elsewhere in CI).

Two reasons this beats the marketplace actions:

1. **The Chrome Web Store API v1 is deprecated and stops working
   2026-10-15.** Most upload actions (`PlasmoHQ/bpp`, `wdzeng/*`, …) still
   speak v1.1 with OAuth refresh tokens. Anything adopted today has to target
   v2 anyway; v2's service-account auth is a plain RS256 JWT exchange that
   `node:crypto` does unaided.
2. **Supply-chain posture.** The 0.7.0 hardening SHA-pinned every third-party
   action; adding an upload action with its own dependency tree to the path
   that ships to users would cut against that for no functional gain.

Alternatives considered:

| Option | Chrome | Firefox | Why not |
| ------ | ------ | ------- | ------- |
| `fregante/chrome-webstore-upload` | v2 (recent) | — | Good library, but a dependency for ~120 lines we can own; still oriented around refresh-token credentials |
| `PlasmoHQ/bpp` | v1 (EOL 2026-10-15) | ✓ | One action for both stores, but a third party with full store credentials in the trust path |
| `web-ext sign --channel listed` | — | ✓ | Official Mozilla tool; ~100 transitive deps added to the lockfile to wrap the same two v5 calls |
| Raw API scripts (chosen) | v2 | v5 | Owned, auditable, no deps; the trade is that API changes are ours to track |

## One-time setup

### Chrome Web Store

1. Google Cloud Console: create (or reuse) a project, enable the **Chrome Web
   Store API**, create a **service account**, and download its JSON key.
2. Chrome Web Store Developer Dashboard → Account: add the service account's
   email. This grants it management of the account's items.
3. Note the **publisher ID** (Dashboard → Account) and the **item ID** (the
   extension's 32-letter ID from its dashboard URL).

### AMO

1. addons.mozilla.org → Manage API keys (`/developers/addon/api/key/`):
   generate a key + secret. JIT keys can be given an expiry — set one and keep
   the date somewhere visible; regenerating is a one-minute rotation.
2. Note the add-on **slug** — the last path segment of the listing URL
   (`addons.mozilla.org/firefox/addon/<slug>/`).

### Repository configuration

Secrets (Settings → Secrets and variables → Actions):

| Name | Value |
| ---- | ----- |
| `CWS_SERVICE_ACCOUNT_JSON` | the full service-account key JSON |
| `AMO_API_KEY` | AMO JWT issuer |
| `AMO_API_SECRET` | AMO JWT secret |

Variables (same page, Variables tab):

| Name | Value |
| ---- | ----- |
| `CWS_PUBLISHER_ID` | Chrome Web Store publisher ID |
| `CWS_ITEM_ID` | the extension's item ID (public) |
| `AMO_ADDON_SLUG` | the AMO listing slug (public) |

Then flip the switch: set the variable `STORE_PUBLISH_AUTOMATION` to `true`
(the `workflow_run` auto-path checks it; until then the workflow is
manual-only). Optionally add a required reviewer on the `stores` environment
(Settings → Environments) so every store submission needs a click.

## Rehearsal and go-live

- **CWS dry run, any time:** Actions → Publish to stores → Run workflow →
  tick *draft*. That runs `--no-publish`: the zip is uploaded as a draft and
  nothing is submitted. Verify the draft in the dashboard, then discard it.
- **AMO has no draft state** — a submission is a submission. Its first live
  run should be a real release; the validation gate (`valid: false` → the job
  fails and prints the report) is the safety net that matters.
- **Go-live:** set `STORE_PUBLISH_AUTOMATION=true` and the next `v*` tag
  publishes everywhere in one push. Both jobs are also runnable by hand with
  an explicit tag.

## Operational notes

- **Reviews are asynchronous** on both sides. The jobs end at "submitted";
  CWS state moves to the dashboard and email, AMO to the listing's review
  status. Neither blocks the GitHub Release.
- **Rejected by review?** Fix forward: bump the version, tag, and the normal
  flow resubmits. AMO reviewer messages arrive in the listing's author tools.
- **Rollout:** `--percentage=N` (workflow_dispatch → draft off, edit the job
  call) stages a CWS rollout; the percentage can be raised later without a
  re-review. AMO has no partial rollout — a listed version goes live on
  approval.
- **Pulling a release:** CWS — disable the item (or a previous version) in the
  dashboard; AMO — disable the version in the listing. Both take effect
  immediately for new users.
- **Source code:** submissions omit the `source` field, matching the manual
  uploads' long-standing answer to the AMO source question. The repository is
  public; if a reviewer ever asks, the source can be attached to the version
  afterwards.
