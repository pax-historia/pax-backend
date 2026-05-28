import type { ReferenceUrlService } from "../types.mjs";
import { ok } from "../util.mjs";

export const echoService: ReferenceUrlService = {
  kindName: "echo.v1",
  pathname: "/_url-services/echo/invoke",
  purpose: "Return args verbatim for the simplest gateway round-trip.",

  handle(request) {
    return ok(request.args);
  },
};
