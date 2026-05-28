# `runtime/child-runner-ivm/`

Default v1 untrusted-JS runner: `isolated-vm` inside a `node child_process` per
game. No outbound network, no environment variables, CPU/memory capped. The
child can only talk to the outside world through the parent's IPC. The current
source pass injects the typed `c.*` surface, including deterministic `c.rng()`
and `c.now()` helpers, into the isolate. When parent bootstrap includes
`testSeed`, those helpers derive from it so scenario runs can pin creator-visible
randomness and time.

See [plan](../../README.md) §"Sandboxing — provisional" for the maintainer-risk
calculus and §"Trust model" for the security floor.
