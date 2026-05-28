import { requireApiKindOracle, requireWsSendOracle } from "../_shared/oracles.mjs";

export default [
  requireApiKindOracle("ai.chat.v1"),
  requireApiKindOracle("flag.search.v1"),
  requireApiKindOracle("projection.sync.v1"),
  requireWsSendOracle("jump-forward-basic"),
];
