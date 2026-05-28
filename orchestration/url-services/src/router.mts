import type { ApiKindRegistration, GatewayHttpRequestBody } from "@pax-backend/ipc-protocol";

import { delayService } from "./services/delay.mjs";
import { echoService } from "./services/echo.mjs";
import { httpFetchService } from "./services/http-fetch.mjs";
import { mockAiV1Service } from "./services/mock-ai-v1.mjs";
import type {
  ReferenceServiceCatalogEntry,
  ReferenceServiceConfig,
  ReferenceServiceResult,
  ReferenceUrlService,
} from "./types.mjs";

const SERVICES: readonly ReferenceUrlService[] = Object.freeze([
  echoService,
  delayService,
  httpFetchService,
  mockAiV1Service,
]);

export const REFERENCE_SERVICE_CATALOG: readonly ReferenceServiceCatalogEntry[] = Object.freeze(
  SERVICES.map(({ kindName, pathname, purpose }) => ({ kindName, pathname, purpose })),
);

export async function handleReferenceService(
  pathname: string,
  request: GatewayHttpRequestBody,
  config: ReferenceServiceConfig,
): Promise<ReferenceServiceResult> {
  const service = SERVICES.find((candidate) => candidate.pathname === pathname);
  if (!service) {
    return {
      handled: false,
      statusCode: 404,
      body: { error: "notFound", detail: { pathname } },
    };
  }
  return service.handle(request, config);
}

export function referenceKindRegistrations(baseUrl: string): readonly ApiKindRegistration[] {
  const normalized = baseUrl.replace(/\/+$/, "");
  return REFERENCE_SERVICE_CATALOG.map(({ kindName, pathname }) => ({
    kindName,
    url: `${normalized}${pathname}`,
  }));
}
