import type { ReferenceUrlService } from "../types.mjs";
import { estimateTokenCount, ok, sha256Hex, stableSerialize } from "../util.mjs";

export const mockAiV1Service: ReferenceUrlService = {
  kindName: "mock-ai.v1",
  pathname: "/_url-services/mock-ai.v1/invoke",
  purpose: "Return deterministic ai-shaped responses keyed by the args hash.",

  handle(request) {
    const fingerprint = sha256Hex(stableSerialize(request.args)).slice(0, 16);
    return ok({
      id: `mock-ai.v1:${fingerprint}`,
      model: "mock-ai.v1",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: `mock-ai.v1 response ${fingerprint}`,
          },
          finishReason: "stop",
        },
      ],
      usage: {
        inputTokens: estimateTokenCount(request.args),
        outputTokens: 4,
      },
    });
  },
};
