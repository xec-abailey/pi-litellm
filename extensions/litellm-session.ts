/**
 * LiteLLM Session Grouping Extension for Pi
 *
 * Injects `litellm_session_id` into every outgoing request payload so all
 * API calls within one Pi session are grouped in LiteLLM's session logs.
 *
 * Uses `before_provider_request` to modify the payload without touching
 * provider config (avoids apiKey/baseUrl side effects).
 */
import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let sessionId: string | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) {
      sessionId = undefined;
      return;
    }

    // Extract session ID from filename
    // Format: 2026-05-06T16-44-04-785Z_019dfe2c-d730-7019-89c1-a7c26f9511ee.jsonl
    const filename = basename(sessionFile, ".jsonl");
    const uuidMatch = filename.match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
    );
    sessionId = uuidMatch?.[1] ?? filename;
  });

  pi.on("before_provider_request", (event) => {
    if (!sessionId) return;
    if (typeof event.payload !== "object" || event.payload === null) return;

    // Inject litellm_session_id as a top-level field in the request body.
    // LiteLLM reads this from the root of the payload (not from metadata)
    // and strips it before forwarding to the upstream provider.
    // Requires `drop_params: true` in litellm_settings (already set).
    return {
      ...(event.payload as Record<string, unknown>),
      litellm_session_id: sessionId,
    };
  });
}
