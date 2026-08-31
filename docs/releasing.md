# Releasing Apogee

Apogee releases are Chrome-only. Beginning with `v0.9.0`, the supported path is
the manually dispatched `Release` GitHub Actions workflow. It creates the exact
GitHub tag and immutable GitHub Release, then uploads that Release's Chrome ZIP
to the Chrome Web Store and submits it for review. There is no deferred Chrome
publish step: Chrome is told to publish to 100% immediately after Google
approves the submission.

The workflow is deliberately the only release writer. Do not create `v*` tags,
create or edit GitHub Releases, replace release assets, upload Chrome packages,
or submit Chrome revisions outside this workflow, except for the documented
one-time `v0.8.0` transition below. Its retry guarantees depend on that rule.

## What a release run does

One workflow run is authorization for one exact pair:

- an exact stable tag such as `v0.9.0`; and
- the full 40-character commit SHA on `main` that will be released.

Before approval, the workflow validates the inputs, release notes, package and
manifest versions, runs the typecheck and tests, and reproducibly builds the
Chrome ZIP. After approval it:

1. checks the Chrome Web Store's current state without mutating it;
2. rebuilds the exact commit and requires the ZIP digest to match preflight;
3. creates or safely resumes the exact GitHub tag and Release;
4. verifies that the GitHub Release is immutable;
5. downloads that exact immutable ZIP from the GitHub Release;
6. verifies its SHA-256 digest and durably records an upload-attempt guard;
7. uploads it to Chrome and replaces that guard with an exact upload receipt;
8. durably records a submission-attempt guard; and
9. submits it with `DEFAULT_PUBLISH`, `deployPercentage: 100`,
   `skipReview: false`, and `blockOnWarnings: true`.

`DEFAULT_PUBLISH` means that the extension is published automatically after
Google approves it. A successful workflow can therefore mean either “pending
Chrome review” or “already published”; it does not imply that Google has
finished reviewing the submission.

## One-time GitHub and Google setup

Complete this setup before enabling the release workflow for general use.

### 1. Create the release GitHub App

Create an organization-owned private GitHub App, for example **Apogee Release
Bot**, with webhooks disabled. Give it only these repository permissions:

- **Contents: Read and write** — create the tag and GitHub Release and upload
  assets.
- **Administration: Read-only** — verify that immutable releases are enabled.

Install the App only on `Resolvr-io/apogee`. Generate a private key and retain
the downloaded PEM long enough to add it as the environment secret described
below. Use the App's **Client ID**, not its App ID or a client secret.

### 2. Create the four GitHub environments

In **Repository settings → Environments**, create these exact environment
names. For every environment, restrict deployment branches and tags to the
`main` branch only.

#### `release-approval`

- Required reviewers: `dmnyc` and `tvolk131`.
- Only one approval is required. GitHub treats the reviewer list as “either,”
  not “both.”
- Enable **Prevent self-review**.
- Disable **Allow administrators to bypass configured protection rules**.
- Do not add secrets or variables.

The person who dispatches a run cannot approve it. Consequently:

- if `tvolk131` dispatches, `dmnyc` must approve;
- if `dmnyc` dispatches, `tvolk131` must approve; and
- if another repository writer dispatches, either reviewer may approve.

Anyone with repository write access may queue a run. The protected environment,
not permission to click **Run workflow**, is the release authorization boundary.

#### `github-production`

Do not configure reviewers. Add:

| Kind | Name | Value |
| --- | --- | --- |
| Environment variable | `RELEASE_BOT_CLIENT_ID` | The release GitHub App's Client ID |
| Environment secret | `RELEASE_BOT_PRIVATE_KEY` | The complete generated PEM, including its `BEGIN` and `END` lines |

Keep these credentials at environment scope rather than repository scope. The
workflow's built-in `GITHUB_TOKEN` remains read-only; GitHub mutations use a
short-lived installation token minted for this App.

#### `chrome-production`

Do not configure reviewers. Add these environment variables:

| Name | Value |
| --- | --- |
| `GCP_PROJECT_ID` | `apogee-506917` |
| `GCP_WIF_PROVIDER` | `projects/1091769346813/locations/global/workloadIdentityPools/apogee-github/providers/apogee-release` |
| `CWS_SERVICE_ACCOUNT` | `apogee-cws-release@apogee-506917.iam.gserviceaccount.com` |
| `CWS_PUBLISHER_ID` | `bd537829-9f1e-439d-affe-c6d79c8ef070` |
| `CWS_EXTENSION_ID` | `lbepaaibhmjmloagoggjhocdkelogamo` |

There is intentionally no Google secret and no service-account JSON key.
GitHub's OIDC token is exchanged through Workload Identity Federation for a
short-lived Google access token. The service account must remain linked in the
Chrome Web Store Developer Dashboard to the publisher that owns the Apogee
item, and the Chrome Web Store API must remain enabled in project
`apogee-506917`.

The Workload Identity Provider is intentionally constrained to all of the
following claims:

- repository owner ID `146979718`;
- repository ID `1301157317`;
- ref `refs/heads/main`;
- environment `chrome-production`;
- workflow ref
  `Resolvr-io/apogee/.github/workflows/release.yml@refs/heads/main`;
- event `workflow_dispatch`; and
- runner environment `github-hosted`.

The service account needs this binding and no long-lived GitHub credential:

```text
role: roles/iam.workloadIdentityUser
member: principalSet://iam.googleapis.com/projects/1091769346813/locations/global/workloadIdentityPools/apogee-github/attribute.repository_id/1301157317
```

Human `roles/iam.serviceAccountTokenCreator` grants used during setup should be
removed after testing. A successful service-account `fetchStatus` call is the
final read-only credential check.

#### `release-notifications`

Do not configure reviewers. Slack notification is optional and does not block
release setup. When it is wanted, create an incoming Slack webhook for the
existing `#apogee` channel and add it as this environment secret:

| Kind | Name | Value |
| --- | --- | --- |
| Environment secret | `SLACK_RELEASE_WEBHOOK_URL` | The complete Slack incoming-webhook URL |

If the secret is absent, the notification job exits successfully without
sending anything. Notification failure is best-effort and does not change the
release result. Keeping the webhook at environment scope prevents a manually
dispatched copy of the workflow on another branch from reading it.

### 3. Protect release code and tags

Ensure the `main` branch ruleset requires pull requests and a Code Owner review.
The repository's `.github/CODEOWNERS` file assigns the release workflow,
release helpers, release notes, and version/build inputs to `dmnyc` and
`tvolk131`; that file has no enforcement effect unless Code Owner review is
enabled in branch protection.

Create an active tag ruleset targeting `v*` with creation, update, and deletion
restricted. Add only the release GitHub App as an **Always allow** bypass actor.
Do not add repository administrators or ordinary users as bypass actors. Do not
require signed tags: the workflow creates an exact lightweight tag through the
App, and a signed-tag rule would reject it.

The ruleset makes the workflow's App the only normal way to create a release
tag. Immutable releases separately prevent published Release metadata and
assets from being rewritten.

### 4. Enable immutable releases

After the workflow, environments, App installation, and tag ruleset are ready,
open **Repository settings → General → Releases** and select **Enable release
immutability**. GitHub applies this only to future releases, so the existing
`v0.8.0` Release remains mutable. The workflow checks this setting immediately
before publishing and fails closed if it is not enabled.

GitHub provides an administrative control/API to disable repository release
immutability later, so the repository setting is reversible. Do not use that as
a routine repair mechanism: once a release is published, treat it as permanent
and fix mistakes in the next patch release.

## Preparing `v0.9.0` and later

Prepare the release in a pull request. The commit ultimately dispatched must
contain all of these changes together:

1. Set `package.json` to the unprefixed stable version, for example `0.9.0`.
   The Chrome manifest version is derived from it.
2. Add `release-notes/v0.9.0.md`. Its first nonblank line must be exactly
   `# Apogee v0.9.0`; its body must be meaningful and contain no `TBD`, `TODO`,
   or placeholder text. See `release-notes/README.md`.
3. Include every code and asset change intended for that version.
4. Merge the PR to `main` and wait for required CI to pass.

Copy the full 40-character SHA of the resulting `main` commit. A short SHA is
not accepted.

If commit `x` is missing its release-notes file, no version is burned: preflight
fails before any tag or Release is created. Add the notes in a later commit `y`
and dispatch the same intended tag with `y`'s full SHA. The same applies to any
other preflight-only failure. Once the workflow has created a matching remote
tag or Release checkpoint, however, that tag is bound permanently to its
original SHA.

## Dispatching and approving

1. Open **Actions → Release → Run workflow**.
2. Select the `main` branch.
3. Enter the exact tag, such as `v0.9.0`.
4. Enter the full 40-character `main` commit SHA.
5. Start the workflow and review the preflight results.
6. The reviewer who did not initiate the run opens its pending deployment,
   selects `release-approval`, and chooses **Approve and deploy**.

For a brand-new tag, the requested SHA must still be the current tip of `main`
immediately before the first mutation. If another commit lands first, the run
fails without creating the release. If that newer commit is also intended for
the release and still contains the same version and notes, dispatch a new run
with its SHA; the new run requires a new approval.

Approval applies to all normal safe retries for that exact run. It is isolated
in its own successful job, so **Re-run failed jobs** leaves the successful
approval in place. **Re-run all jobs** or creating a new workflow run requests
approval again.

## Concurrency and ownership

All releases use one repository-wide concurrency group. Runs queue instead of
cancelling one another, so at most one release can mutate GitHub or Chrome at a
time. If a stale or incorrect run is waiting for approval, reject or cancel it
so it does not hold the queue.

Concurrency controls only this GitHub workflow. It cannot serialize manual
edits in the GitHub Releases UI, Git tag pushes from local machines, Chrome
Developer Dashboard actions, or other automation. The tag ruleset and immutable
releases enforce most of the GitHub side; on Chrome, “this workflow is the only
writer” remains an operational requirement.

## Failure and retry guide

The helpers automatically retry transient read-only requests. They do not
blindly retry upload, publish, tag, Release, or asset-creation requests. After an
uncertain response, they inspect the remote state and resume only if it matches
the approved tag, SHA, version, asset names, and digests.

### Preflight or build failure

Fix the problem in a new commit on `main`. If no tag or Release checkpoint was
created, keep the same intended version and dispatch the new full SHA. This
includes a missing notes file, failed typecheck/test, or non-reproducible build.

### GitHub tag, Release, or asset failure

Choose **Re-run failed jobs**. The helper treats an exact matching tag, draft,
published Release, or asset as a checkpoint and resumes. A tag pointing to a
different SHA, an asset with different bytes, or conflicting Release metadata
is a hard failure; do not delete or overwrite the conflict. Investigate it and,
if the published artifact is wrong, use the next patch version.

### Chrome upload or network failure

If Chrome reports the version as pending review or already published, **Re-run
failed jobs** is safe and becomes a no-op for completed steps. A successful
upload job stores a non-secret mutation journal as an Actions artifact keyed to
that workflow run (retained for up to 90 days), so a failed submit job can be
retried without uploading the package again.

Each Chrome mutation is two-phase: the workflow writes and uploads a prepared
guard before it sends the API request, then uploads the result journal after
the request. If the runner or network disappears at any point after the first
checkpoint, the next attempt restores that guard and refuses to replay the POST
unless Chrome itself proves the target is already submitted or published.

There is one API limitation: `fetchStatus` does not identify the version or
digest of an uploaded but unsubmitted draft. If the upload request loses its
response and the helper reports `AMBIGUOUS_UPLOAD`, do not blindly rerun the
upload job. Wait for Chrome's processing to settle and inspect the Developer
Dashboard. Escalate to both release owners before manually completing or
replacing that draft; record the exact tag, SHA, GitHub asset digest, and action
taken in the workflow run. This is exceptional recovery, not a second release
path.

Always retry Chrome failures from the original workflow run. A brand-new
dispatch has a different run ID and intentionally cannot inherit the original
mutation journal or its approval. The immutable `RELEASE-METADATA.json` asset
also records the originating run ID, so another run cannot take over an
existing Release transaction. If a runner is cancelled or lost during a Chrome
mutation, its durable prepared guard deliberately blocks an automatic retry;
manually reconcile the Developer Dashboard with both release owners first.

### Chrome validation warning

Warnings block submission by design. Read the structured warning in the failed
job and classify the fix:

- If only store listing metadata, privacy answers, or another dashboard-owned
  setting must change, fix that setting and choose **Re-run failed jobs** for
  the same tag and SHA. The upload receipt allows the submit job to resume.
- If the ZIP or source must change, the immutable GitHub Release cannot be
  replaced. Leave that GitHub version as an accurate historical artifact, bump
  to the next patch version (for example `v0.10.1`), commit new release notes,
  and start a newly approved run. `v0.10.0` may therefore exist on GitHub
  without ever reaching Chrome.

Do not turn off `blockOnWarnings`, change the deploy percentage, skip review, or
switch to staged publishing to get around a warning.

### Rejected or unexpected Chrome state

The workflow fails closed for a taken-down item, policy warning, partial
rollout, newer known store version, another active submission, or an unexpected
state such as `REJECTED`, `CANCELLED`, or `STAGED`. Inspect and resolve the
Chrome Developer Dashboard state first. If remediation changes the package,
release a new patch version. Do not repeatedly rerun a blocked job.

Chrome does not provide this workflow with a completion webhook. Until a
separate status monitor is added, follow final review or rejection in the
Developer Dashboard (or with `fetchStatus`). The workflow Slack notification
reports what the submission job observed, not a later Google review decision.

## One-time `v0.8.0` transition

`v0.8.0` was tagged and published through the old GitHub-only workflow before
this system existed. Do not recreate its tag or GitHub Release, and do not try
to force it through the new preflight. The verified release identity is:

```text
tag: v0.8.0
commit: 12341c260eb9927eadb3eb5a12de8320059bba94
asset: apogee-0.8.0-chrome.zip
sha256: ede6635050e3b0d79b3a99a9d308a1f66c3fe4dd1ec0e5e74c49a53b13d3e130
```

If Chrome already reports `0.8.0` pending or published at 100%, record that and
skip this exception. Otherwise, before the first `v0.9.0` release:

1. download the existing `apogee-0.8.0-chrome.zip` asset from the GitHub
   `v0.8.0` Release;
2. verify its SHA-256 against the value above and confirm the ZIP manifest says
   `0.8.0`;
3. upload that exact ZIP once in the Chrome Web Store Developer Dashboard;
4. submit it for ordinary review, immediate publication after approval, and
   100% deployment; stop rather than bypass any warning; and
5. use `fetchStatus` to confirm `0.8.0` is pending review or published, and save
   that result with the release record.

This is the sole planned manual exception. The existing `v0.8.0` GitHub Release
will not become immutable retroactively, but its recorded digest remains the
verification anchor.

## Recommended rollout order

1. Complete the one-time `v0.8.0` Chrome transition, if still needed.
2. Create and install the release GitHub App, then configure all four
   environments and their exact variables/secrets. The Slack secret may remain
   absent.
3. Merge the release workflow, helpers, tests, release notes convention, and
   Code Owners file into `main`.
4. Enable required Code Owner review for `main` and activate the App-only `v*`
   tag ruleset.
5. Enable repository release immutability.
6. Prepare and merge the `v0.9.0` version/notes PR, then perform the first fully
   automated release using its exact `main` SHA.
   Its `chrome_readiness` job exchanges the GitHub OIDC identity and calls
   `fetchStatus` read-only before any GitHub or Chrome mutation; an
   authentication or store-state problem therefore fails closed.
7. Confirm the GitHub Release is immutable, Chrome reports `0.9.0` pending or
   published at 100%, and the Slack message reached `#apogee`.

Useful references:

- [GitHub deployment environments and required reviewers](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)
- [GitHub immutable releases](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes)
- [Chrome Web Store `publish` API](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish)
