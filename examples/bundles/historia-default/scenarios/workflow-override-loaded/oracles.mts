import { requireHostEventOracle, requireWsSendOracle } from "../_shared/oracles.mjs";

export default [
  requireHostEventOracle("workflowOverride"),
  requireWsSendOracle("workflow-override-loaded"),
];
