export {
  REFERENCE_SERVICE_CATALOG,
  handleReferenceService,
  referenceKindRegistrations,
  referenceServiceMetricsSnapshot,
} from "./router.mjs";
export { referenceServiceConfigFromEnv } from "./config.mjs";
export type {
  ReferenceServiceCatalogEntry,
  ReferenceServiceConfig,
  ReferenceServiceMetricsSnapshot,
  ReferenceServiceResult,
  ReferenceUrlService,
} from "./types.mjs";
