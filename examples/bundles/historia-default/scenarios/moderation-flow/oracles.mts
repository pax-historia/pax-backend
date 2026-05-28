import { requireApiKindOracle, requireWsSendOracle } from "../_shared/oracles.mjs";

export default [
  requireApiKindOracle("moderation.audit.v1"),
  requireApiKindOracle("ai.chat.v1"),
  requireWsSendOracle("moderation-flow"),
];
