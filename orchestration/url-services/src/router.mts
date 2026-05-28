import type { ApiKindRegistration, GatewayHttpRequestBody } from "@pax-backend/ipc-protocol";
import { withPaxSpanFromTraceId } from "@pax-backend/node-telemetry";

import { delayService } from "./services/delay.mjs";
import { echoService } from "./services/echo.mjs";
import { httpFetchService } from "./services/http-fetch.mjs";
import { mockAiV1Service } from "./services/mock-ai-v1.mjs";
import type {
  ReferenceServiceCatalogEntry,
  ReferenceServiceConfig,
  ReferenceServiceMetricsSnapshot,
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

interface MutableReferenceServiceMetrics {
  invocationsTotal: number;
  errorsTotal: number;
  durationMsSum: number;
}

const metricsByKindName = new Map<string, MutableReferenceServiceMetrics>(
  SERVICES.map((service) => [
    service.kindName,
    {
      invocationsTotal: 0,
      errorsTotal: 0,
      durationMsSum: 0,
    },
  ]),
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

  return withPaxSpanFromTraceId(
    `urlsvc.${service.kindName}.invoke`,
    {
      kind: service.kindName,
      game_id: request.context.gameId,
      run_id: request.context.runId,
      bundle_name: request.context.bundleName,
      bundle_compat_tag: request.context.bundleCompatTag,
    },
    request.context.traceId,
    async (span) => {
      const metrics = metricsFor(service.kindName);
      metrics.invocationsTotal += 1;
      const startedAt = Date.now();
      try {
        const result = await service.handle(request, config);
        span.setAttribute("http.response.status_code", result.statusCode);
        if (result.statusCode >= 400) {
          metrics.errorsTotal += 1;
        }
        return result;
      } catch (err) {
        metrics.errorsTotal += 1;
        throw err;
      } finally {
        metrics.durationMsSum += Math.max(0, Date.now() - startedAt);
      }
    },
  );
}

export function referenceKindRegistrations(baseUrl: string): readonly ApiKindRegistration[] {
  const normalized = baseUrl.replace(/\/+$/, "");
  return REFERENCE_SERVICE_CATALOG.map(({ kindName, pathname }) => ({
    kindName,
    url: `${normalized}${pathname}`,
  }));
}

export function referenceServiceMetricsSnapshot(): readonly ReferenceServiceMetricsSnapshot[] {
  return SERVICES.map((service) => {
    const metrics = metricsFor(service.kindName);
    return {
      kindName: service.kindName,
      invocationsTotal: metrics.invocationsTotal,
      errorsTotal: metrics.errorsTotal,
      durationMsSum: metrics.durationMsSum,
    };
  });
}

function metricsFor(kindName: string): MutableReferenceServiceMetrics {
  const existing = metricsByKindName.get(kindName);
  if (existing) return existing;
  const metrics: MutableReferenceServiceMetrics = {
    invocationsTotal: 0,
    errorsTotal: 0,
    durationMsSum: 0,
  };
  metricsByKindName.set(kindName, metrics);
  return metrics;
}
