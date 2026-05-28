import type {
  GatewayHttpRequestBody,
  GatewayHttpResponseBody,
} from "@pax-backend/ipc-protocol";

export interface ReferenceServiceConfig {
  readonly httpFetchAllowlist: readonly string[];
  readonly delayMaxMs: number;
}

export interface ReferenceServiceResult {
  readonly handled: boolean;
  readonly statusCode: number;
  readonly body: GatewayHttpResponseBody;
}

export interface ReferenceUrlService {
  readonly kindName: string;
  readonly pathname: string;
  readonly purpose: string;
  handle(
    request: GatewayHttpRequestBody,
    config: ReferenceServiceConfig,
  ): ReferenceServiceResult | Promise<ReferenceServiceResult>;
}

export interface ReferenceServiceCatalogEntry {
  readonly kindName: string;
  readonly pathname: string;
  readonly purpose: string;
}
