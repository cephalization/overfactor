import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  activityEvent,
  type PiSessionIdentity,
  sessionEndEvent,
  sessionStartEvent,
  stoppedEvent,
  userPromptEvent,
} from "./events.ts";
import { createHookEventSink, type HookEventSink, SHUTDOWN_FLUSH_TIMEOUT_MS } from "./transport.ts";

export * from "./events.ts";
export * from "./transport.ts";

function identity(ctx: ExtensionContext): PiSessionIdentity {
  return {
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
    transcriptPath: ctx.sessionManager.getSessionFile() ?? null,
  };
}

/** Registers Pi lifecycle hooks that map onto Overfactor's agent-neutral SDK events. */
export function registerPiIntegration(
  pi: ExtensionAPI,
  sink: HookEventSink = createHookEventSink(),
): void {
  pi.on("session_start", (_event, ctx) => {
    const current = identity(ctx);
    void sink.send(sessionStartEvent(current));
    if (ctx.isIdle()) void sink.send(stoppedEvent(current));
  });

  pi.on("before_agent_start", (event, ctx) => {
    void sink.send(userPromptEvent(identity(ctx), event.prompt));
  });

  pi.on("agent_start", (_event, ctx) => {
    void sink.send(activityEvent(identity(ctx)));
  });

  pi.on("tool_execution_start", (event, ctx) => {
    void sink.send(activityEvent(identity(ctx), event.toolName));
  });

  pi.on("agent_settled", (_event, ctx) => {
    void sink.send(stoppedEvent(identity(ctx)));
  });

  pi.on("session_shutdown", async (event, ctx) => {
    // /reload replaces the extension runtime but keeps the same Pi session.
    if (event.reason === "reload") return;
    // `send` resolves with the whole serialized queue, and Pi awaits this
    // handler unbounded during dispose() — cap the wait so quitting Pi never
    // stalls on a backlog of POSTs against a wedged daemon.
    await Promise.race([
      sink.send(sessionEndEvent(identity(ctx), event.reason)),
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS).unref()),
    ]);
  });
}

export default registerPiIntegration;
