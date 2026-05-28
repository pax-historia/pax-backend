# Substrate contract specification

> Stub. The full spec is in [the plan README](../README.md) §"The runtime
> contract", §"Strong platform guarantees", §"Admin surface", §"Bundle
> compatibility", §"Session observability" until this doc gets written for
> real.

This document is the formal specification that the runtime and the
scenario-runner implement against. It enumerates:

- Every channel signature
- Every lifecycle hook payload shape
- The `BundleManifest` shape and the two enforcement gates (flip + placement)
- The library-defined HTTP envelope between gateway and URL services
- Every Strong Platform Guarantee, mapped to the oracle that proves it

Substrate guarantees only. Billing semantics belong to operator-owned URL
services and their own specs.

Step 11 of the plan's kickoff.
