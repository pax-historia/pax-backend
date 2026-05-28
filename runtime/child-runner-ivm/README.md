# `runtime/child-runner-ivm/`

Default v1 untrusted-JS runner: `isolated-vm` inside a `node child_process` per
game. No outbound network, no environment variables, CPU/memory capped. The
child can only talk to the outside world through the parent's IPC.

Stub. Implementation lands in step 7 of the plan's kickoff.

See [plan](../../README.md) §"Sandboxing — provisional" for the maintainer-risk
calculus and §"Trust model" for the security floor.
