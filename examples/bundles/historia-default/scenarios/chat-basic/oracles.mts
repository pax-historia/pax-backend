import { requireApiKindOracle, requireWsSendOracle } from "../_shared/oracles.mjs";

export default [requireApiKindOracle("ai.chat.v1"), requireWsSendOracle("chat-basic")];
