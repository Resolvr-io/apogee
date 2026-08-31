# Release notes

Every stable release must include one committed Markdown file named after its
exact tag:

```text
release-notes/vX.Y.Z.md
```

The first nonblank line must be exactly `# Apogee vX.Y.Z`. The body must contain
real release notes and must not contain `TBD`, `TODO`, or placeholder text. The
version must match `package.json`; `package.json` is also the source of the
Chrome manifest version.

The protected release workflow uses this file verbatim as the GitHub Release
body. Once that release is published its tag and assets are immutable, so do
not edit a published version's file or replace its package. A package change
requires the next patch version.

If preflight rejects a candidate before creating any remote tag or release,
commit the missing or corrected notes and dispatch the same intended tag using
the new commit's full SHA.
