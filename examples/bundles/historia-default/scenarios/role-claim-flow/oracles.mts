import { requireHostEventOracle, requireWsSendOracle } from "../_shared/oracles.mjs";

export default [requireHostEventOracle("participationChanged"), requireWsSendOracle("role-claim-flow")];
