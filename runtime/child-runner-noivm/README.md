# `runtime/child-runner-noivm/`

Alternate untrusted-JS runner that does **not** depend on `isolated-vm`. Runs
the creator bundle in a `node child_process` with the same IPC schema and the
same compute-plane quotas but without an inner VM boundary. Strictly weaker
sandboxing; intended as the conformance gate against `isolated-vm`'s
maintainer-risk story.

**CI runs this runner against the full first-party scenario set on every
release.** If it ever passes when `child-runner-ivm` fails (or vice versa), the
IPC schema has drifted and the release is blocked.

Current source pass implements the same parent/child IPC contract as
`child-runner-ivm`, evaluates the compiled bundle directly in the Node child
process, injects the same `c.*` surface, and can be selected locally with
`PAX_CHILD_RUNNER_KIND=noivm`.
