import type { ApiInvokeResponse } from "@pax-backend/ipc-protocol";

export type { ApiInvokeResponse } from "@pax-backend/ipc-protocol";

export interface ExternalApiChannel {
  /**
   * Invoke an operator-registered URL service kind. Args and result are
   * opaque to the substrate; URL services own application semantics.
   */
  invoke(
    kind: string,
    args: unknown,
    options?: { readonly idempotencyKey?: string },
  ): Promise<ApiInvokeResponse>;
}
