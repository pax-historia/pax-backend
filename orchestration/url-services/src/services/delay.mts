import { setTimeout as sleep } from "node:timers/promises";

import type { ReferenceUrlService } from "../types.mjs";
import { clampNumber, ok, readObjectNumber } from "../util.mjs";

export const delayService: ReferenceUrlService = {
  kindName: "delay.v1",
  pathname: "/_url-services/delay/invoke",
  purpose: "Return args.result or args after a bounded delay.",

  async handle(request, config) {
    const args = request.args;
    const delayMs = clampNumber(readObjectNumber(args, "delayMs") ?? 0, 0, config.delayMaxMs);
    await sleep(delayMs);
    const result = isObjectWithOwnKey(args, "result") ? args["result"] : args;
    return ok(result);
  },
};

function isObjectWithOwnKey(value: unknown, key: string): value is Record<string, unknown> {
  return !!value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, key);
}
