# `tooling/bundle-tools/`

Build / publish / fetch for creator bundles. v1 uses creator-scoped,
monotonic, **immutable-by-storage-policy** object names (e.g.
`bundles/<creator-id>/v3`) in `pax-backend-blobs`. The directory entry
references the bundle by name.

Optional sha256 + signature helpers as defense-in-depth (off by default in v1;
see [plan](../../README.md) §"Bundle integrity & verification").

Stub.
