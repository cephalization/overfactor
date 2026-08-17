import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentIntegrationManifest } from "@overfactor/sdk";
import {
  type ConversationMessageReceiver,
  createConversationMessageReceiver,
} from "./conversation.ts";
import {
  activityEvent,
  type PiSessionIdentity,
  sessionEndEvent,
  sessionStartEvent,
  stoppedEvent,
  userPromptEvent,
} from "./events.ts";
import { createHookEventSink, type HookEventSink, SHUTDOWN_FLUSH_TIMEOUT_MS } from "./transport.ts";

export * from "./conversation.ts";
export * from "./events.ts";
export * from "./transport.ts";

export const piIntegrationManifest = {
  agent: "pi",
  capabilities: ["continue-conversation"],
} satisfies AgentIntegrationManifest;

interface ActiveConversationSubscription {
  sessionId: string;
  stop: () => void;
}

const conversationSubscriptionsGlobal = globalThis as typeof globalThis & {
  __overfactorPiConversationSubscriptions?: Map<string, () => void>;
};

/**
 * Pi can re-evaluate an extension without disposing module-level async work.
 * Keep one receiver per session across extension instances so reloads cannot
 * leave competing pollers that deliver the same queued prompt twice.
 */
function conversationSubscriptions(): Map<string, () => void> {
  return (conversationSubscriptionsGlobal.__overfactorPiConversationSubscriptions ??= new Map());
}

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
  conversationReceiver: ConversationMessageReceiver = createConversationMessageReceiver(),
): void {
  let activeConversationSubscription: ActiveConversationSubscription | null = null;

  const stopConversationReceiver = (): void => {
    const active = activeConversationSubscription;
    activeConversationSubscription = null;
    if (active === null) return;
    const subscriptions = conversationSubscriptions();
    if (subscriptions.get(active.sessionId) === active.stop) {
      subscriptions.delete(active.sessionId);
    }
    active.stop();
  };

  pi.on("session_start", (_event, ctx) => {
    const current = identity(ctx);
    void sink.send(sessionStartEvent(current));
    if (ctx.isIdle()) void sink.send(stoppedEvent(current));

    stopConversationReceiver();
    const subscriptions = conversationSubscriptions();
    const staleSubscription = subscriptions.get(current.sessionId);
    if (staleSubscription !== undefined) {
      subscriptions.delete(current.sessionId);
      staleSubscription();
    }
    const stop = conversationReceiver.subscribe(current.sessionId, (message) => {
      if (ctx.isIdle()) {
        pi.sendUserMessage(message.prompt);
      } else {
        pi.sendUserMessage(message.prompt, { deliverAs: "followUp" });
      }
    });
    subscriptions.set(current.sessionId, stop);
    activeConversationSubscription = { sessionId: current.sessionId, stop };
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
    stopConversationReceiver();
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
