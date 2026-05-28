# `sdk/bundle-tools/` — `@pax-backend/bundle-tools`

Creator-facing CLI for building and publishing bundles. Lives in `sdk/`
because it runs on the **creator's** machine (not on a deploy target, not
on a driver). See [`../README.md`](../README.md) for the broader rules
about the `sdk/` zone.

## Commands

| Command | What it does |
|---|---|
| `pax-bundle build <pkg>` | esbuild the bundle's `src/index.mts` to `dist/bundle.js` (IIFE with the `__pax_install` footer the runtime expects). Validates the manifest in-band via `defineBundle`. |
| `pax-bundle publish <pkg>` | Uploads the compiled bundle to `POST /admin/bundles/:bundleName`. Stores under a creator-scoped, monotonic, immutable-by-storage-policy object name in `pax-backend-blobs` (e.g. `bundles/<creator-id>/v3`). |
| `pax-bundle verify <pkg>` | Optional sha256 + signature check as defense-in-depth (off by default in v1; see [plan](../../README.md) §"Bundle integrity & verification"). |

## Sub-layout

```
src/
  commands/<command>.ts    # one file per CLI command
  cli.ts                   # entry point
```

Current source pass adds the package and command modules. The shell script at
[`scripts/build/build-bundles.sh`](../../scripts/build/build-bundles.sh)
remains the local smoke path until this CLI is wired into CI and release
publishing.
