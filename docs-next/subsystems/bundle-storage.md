# Bundle storage

> Layer: **Subsystem**

The substrate owns both the bundle binary (the compiled JS) and the
bundle metadata (manifest + index rows). This subsystem describes the
storage layout, the upload pipeline, the fetch path, the immutability
policy, and the garbage collection model.

## Purpose

Be the canonical, durable, addressable store for every bundle the
substrate will ever load.

## Owns

- The Tigris layout under `bundles/`.
- The Redis index row per bundle (manifest snapshot, upload timestamp,
  uploader id, content sha).
- The upload pipeline (multipart upload from `POST /admin/bundles/:bundleName`).
- The immutability policy (write-once names; binaries are immutable).
- The shard-side bundle cache (one local copy per `(shardId, bundleName)`).
- Garbage collection — bundles unreferenced by any game for >30 days are
  GC candidates, but deletion is admin-driven, not automatic.

## Doesn't own

- The bundle's compile pipeline (`pax-bundle build`; bundle authors
  ship pre-built source via `POST /admin/bundles/:bundleName`).
- Bundle signature verification (out of scope for v1; see
  [`why/why-isolated-vm.md`](../why/why-isolated-vm.md) for the security
  model).
- Bundle execution (Broker + Runner isolate).
- Bundle compatibility decisions (manifest gate at flip/wake — control
  plane and Broker enforce).

## Tigris layout

All bundle artifacts live in one Tigris bucket (`pax-backend-blobs`) under
the `bundles/` prefix:

```
bundles/
  <bundleName>/
    source.js                  // the compiled bundle source, write-once
    manifest.json              // the manifest, write-once, matches the JS-side defineBundle() call
    metadata.json              // upload timestamp, uploader, sha256 of source.js
```

`<bundleName>` is the substrate-unique identifier the vercel backend
chose at upload. It is opaque to the substrate beyond the
immutability/monotonicity rules below.

Example (Pax-historia naming convention):

```
bundles/
  historia-default-v1/
    source.js
    manifest.json
    metadata.json
  historia-default-v2/
    source.js
    manifest.json
    metadata.json
  hello-ws-echo-v1/
    source.js
    manifest.json
    metadata.json
```

## Redis index

For each uploaded bundle, the control plane writes a Redis row at key
`bundle:<bundleName>`:

```jsonc
{
  "bundleName": "historia-default-v5",
  "uploadedAt": "2026-05-27T12:00:00Z",
  "uploadedBy": "vercel-backend",      // bearer-token-derived identity; opaque
  "tigrisPath": "bundles/historia-default-v5/",
  "contentSha256": "sha256:abc123...",
  "sizeBytes": 524288,
  "manifest": {
    "compatTagProduced": "historia:v5",
    "compatTagsAccepted": ["historia:v3", "historia:v4", "historia:v5"],
    "runtimeContractRequired": 1
  }
}
```

The Redis index is the fast path for:
- `GET /admin/bundles/:bundleName` (returns metadata + manifest).
- Compat-tag observability queries (`GET /admin/games/compat-tags`
  enumerates referenced manifests).
- Placement-router lookups for `runtimeContractRequired`.
- Game-create validation (`POST /admin/games` checks the bundle
  exists).

The Tigris layout is the slow path for fetching the actual binary.

## Naming policy

Bundle names are operator-chosen but must conform to:

- **Non-empty**, alphanumeric + hyphens + dots + underscores, ≤256 bytes.
- **Write-once.** A `POST /admin/bundles/:bundleName` for an existing name
  returns `409 bundleNameTaken`.
- **Monotonic per creator scope.** The vercel backend names bundles as
  `<creator-id>/<scope>/v<N>` or similar. The substrate doesn't enforce
  the monotonicity structurally (any name is fine as long as it's
  write-once), but the vercel backend's tooling commits to a convention.
- **Immutable.** Once a bundle's binary + manifest are uploaded, they
  cannot be edited.

There is no rename. Replacing "v5" with a different "v5" is impossible;
to fix a buggy v5, upload v5.1.

## Upload pipeline

`POST /admin/bundles/:bundleName` body:

```jsonc
{
  "manifest": {
    "compatTagProduced": "historia:v5",
    "compatTagsAccepted": ["historia:v3", "historia:v4", "historia:v5"],
    "runtimeContractRequired": 1
  },
  "source": "...compiled JS string..."
}
```

The control plane writes the bundle bytes first and finalizes via a
single Redis index commit. The pipeline is **recoverable**, not atomic
across stores — see "Cross-store commit model" below.

1. Validates the manifest (see
   [`contract/bundle-compatibility.md`](../contract/bundle-compatibility.md)).
   On failure: `400 manifestInvalid`.
2. Refuses if a Redis index row already exists for `bundleName`:
   `409 bundleNameTaken`. (The Redis row is the source of truth for
   "this bundle exists.")
3. Computes `sha256(source)`.
4. Writes the bundle bytes to Tigris under
   `bundles/<bundleName>/{source.js, manifest.json, metadata.json}`.
   These are write-once paths; an interrupted upload's partial bytes
   are not the source of truth.
5. **Finalize**: writes the Redis index row for `bundleName` in a
   single Redis command. This commit is the point at which the bundle
   becomes visible.
6. Emits `bundle.uploaded` history event.
7. Returns 201 Created with `{ bundleName, contentSha256 }`.

For very large bundles (>1 MB), the upload may use multipart; the
substrate exposes only the JSON-body endpoint at v1 (bundle sizes have
been ≤ 500 KB in practice).

### Cross-store commit model

Tigris and Redis are two stores with independent failure modes. The
substrate does **not** claim a multi-store transaction; instead the
upload follows a recoverable-finalize pattern:

- Tigris bytes are written first. They are not yet referenced by any
  Redis row.
- The Redis index commit is the visibility commit. After step 5
  completes, the bundle exists; before step 5 completes, it does not.
- If the process crashes between steps 4 and 5, Tigris holds orphan
  bytes with no Redis row. These are unreachable by any substrate API
  (placement, flip, fetch all key off the Redis row).
- An orphan-bundle sweep in the periodic GC pass (see "Garbage
  collection" below) lists Tigris `bundles/` paths that have no
  matching Redis row and deletes them.

This model gives the caller the guarantee they actually need ("either
this bundle is visible, or it is not") without claiming a cross-store
atomicity property the substrate cannot implement. See
[`contract/storage.md`](../contract/storage.md) §"Engineering latitude"
for the equivalent latitude applied to `c.state` / `c.blob` writes.

## Shard-side bundle cache

When a shard cold-wakes a game, the Broker fetches the bundle source
from Tigris **once per `(shardId, bundleName)` pair**:

1. Check local cache at `/data/bundle-cache/<bundleName>/source.js`.
2. If present and `contentSha256` matches the Redis row: use it.
3. Else: download from Tigris; write to local cache.
4. Deliver the source to the Runner via the `assign` bridge message; the
   Runner evals it into the game's isolate.

The cache lives on the shard's local scratch disk. Cache TTL: indefinite,
but it is treated as scratch space — anything in the cache is safe to
lose; the shard re-downloads from Tigris on the next miss. The substrate
makes no durability claim about cached bundle bytes (and keeps no durable
volume in the state path; state durability is Tigris-canonical).

## Garbage collection

Bundles are write-once and never automatically deleted. A bundle is a
**deletion candidate** when:

- No active game references it as `currentBundleName`.
- No game's `rollbackBackup.previousBundleName` references it (7-day
  rollback window).
- It hasn't been uploaded in the last 30 days (grace period for newly
  uploaded bundles that haven't been used yet).

`DELETE /admin/bundles/:bundleName` succeeds only if those three
conditions hold; otherwise `409 bundleInUse` with a list of referencing
games/backups.

The vercel backend's tooling runs a periodic GC sweep that lists
candidate bundles and either deletes them or extends their retention.
The substrate does not auto-GC.

## Bundle fetch into the Runner

The Runner does **not** fetch from Tigris. The Broker delivers the source
via the `assign` bridge message. This keeps:

- The Runner's privilege set minimal (credential-less; no S3 credentials).
- The fetch path centralized (the Broker's cache hits cover every game on
  the shard).
- Bundle source verification simple (the Broker has already validated
  `contentSha256` against the Redis row).

## Trust position

**Platform-trusted** for the upload pipeline (the control plane writes
to Tigris).

**Shard-trusted** for the local cache (the Broker reads from Tigris with
shard creds and caches to local scratch).

**Untrusted from inside the isolate** — the isolate has no access to
Tigris or the cache, the Runner is credential-less, and the isolate sees
only the source the Broker delivered.

## Observability surface

| Signal | Notes |
|---|---|
| `bundle.uploaded` history event | Per upload |
| `bundle.loaded` history event | Per wake; includes `contentSha256` |
| `bundle.loaded.failed` history event | If shard-side fetch or eval fails |
| `bundle.deleted` history event | On admin delete |
| Metrics: `pax_control_bundle_upload_duration_seconds`, `pax_control_bundle_storage_bytes` | Control plane Prometheus |
| Metrics: `pax_broker_bundle_fetch_duration_seconds`, `pax_broker_bundle_cache_hit_total` | Per-shard Prometheus |

## End-state contract

- **Upload is recoverable.** The Redis index commit is the visibility
  point; before it, no substrate API can see the bundle. Interrupted
  uploads leave Tigris orphans that the GC sweep cleans up. (See
  "Cross-store commit model" above.)
- **Bundle source is byte-identical across all shards** that ever load
  the bundle (`contentSha256` is verified at every fetch).
- **Bundle names are unforgeable** — write-once at the control plane.
- **Bundle deletion is safe** — refused if anything references the
  bundle.

## Cross-references

- [`contract/bundle-compatibility.md`](../contract/bundle-compatibility.md) — manifest contract
- [`control-plane-admin-api.md`](control-plane-admin-api.md) — upload endpoint
- [`broker.md`](broker.md) — shard-side fetch + cache, delivery to Runners
- [`reference/admin-api.md`](../reference/admin-api.md) — endpoint schemas
- [`vision/non-goals.md`](../vision/non-goals.md) — bundle signing is not in scope
