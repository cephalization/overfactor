import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionEvent,
} from "@earendil-works/pi-coding-agent";
import type { HookEvent } from "@overfactor/sdk";
import { describe, expect, it } from "vitest";
import { registerPiIntegration } from "../src/index.ts";
import type { ConversationMessageReceiver } from "../src/conversation.ts";
import type { HookEventSink } from "../src/transport.ts";

type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => void | Promise<void>;

let nextSessionNumber = 0;

function harness(idle = true, sessionId = `pi-session-${++nextSessionNumber}`) {
  const handlers = new Map<string, Handler>();
  const reported: HookEvent[] = [];
  const sentUserMessages: Array<{ prompt: string; deliverAs?: "steer" | "followUp" }> = [];
  let receiveMessage: ((prompt: string) => Promise<void>) | null = null;
  let receiverStops = 0;
  const piDouble = {
    on(event: string, handler: Handler) {
      handlers.set(event, handler);
    },
    sendUserMessage(prompt: string, options?: { deliverAs?: "steer" | "followUp" }) {
      sentUserMessages.push({ prompt, ...options });
    },
  };
  // SAFETY: The test double implements every ExtensionAPI member used by registerPiIntegration.
  const pi = piDouble as ExtensionAPI;
  const sink: HookEventSink = {
    async send(event) {
      reported.push(event);
    },
  };
  const contextDouble = {
    cwd: "/repo",
    isIdle: () => idle,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/sessions/${sessionId}.jsonl`,
    },
  };
  // SAFETY: The test double implements every ExtensionContext member used by registerPiIntegration.
  const ctx = contextDouble as ExtensionContext;
  const receiver: ConversationMessageReceiver = {
    subscribe(subscribedSessionId, onMessage) {
      expect(subscribedSessionId).toBe(sessionId);
      receiveMessage = async (prompt) =>
        onMessage({
          id: "00000000-0000-4000-8000-000000000000",
          prompt,
          createdAt: "2026-08-16T12:00:00.000Z",
        });
      return () => {
        receiverStops += 1;
      };
    },
  };

  registerPiIntegration(pi, sink, receiver);

  async function emit(name: string, event: ExtensionEvent): Promise<void> {
    const handler = handlers.get(name);
    if (handler === undefined) throw new Error(`missing ${name} handler`);
    await handler(event, ctx);
  }

  return {
    emit,
    reported,
    sentUserMessages,
    deliver: async (prompt: string) => {
      if (receiveMessage === null) throw new Error("receiver not started");
      await receiveMessage(prompt);
    },
    receiverStops: () => receiverStops,
  };
}

describe("registerPiIntegration", () => {
  it("reports the Pi lifecycle and ignores extension-only reload shutdowns", async () => {
    const { emit, reported } = harness();

    await emit("session_start", { type: "session_start", reason: "startup" });
    await emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "Fix the bug",
      systemPrompt: "",
      systemPromptOptions: { cwd: "/repo" },
    });
    await emit("agent_start", { type: "agent_start" });
    await emit("tool_execution_start", {
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "edit",
      args: {},
    });
    await emit("agent_settled", { type: "agent_settled" });
    await emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
    await emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    expect(reported.map((event) => event.type)).toEqual([
      "session-start",
      "stopped",
      "user-prompt",
      "activity",
      "activity",
      "stopped",
      "session-end",
    ]);
    expect(reported[2]).toMatchObject({ prompt: "Fix the bug" });
    expect(reported[4]).toMatchObject({ tool: "edit" });
    expect(reported[6]).toMatchObject({ reason: "quit" });
  });

  it("does not report an initial idle event when Pi is already active", async () => {
    const { emit, reported } = harness(false);

    await emit("session_start", { type: "session_start", reason: "reload" });

    expect(reported.map((event) => event.type)).toEqual(["session-start"]);
  });

  it("delivers app messages immediately while idle and as follow-ups while busy", async () => {
    const idle = harness(true);
    await idle.emit("session_start", { type: "session_start", reason: "startup" });
    await idle.deliver("Idle message");
    expect(idle.sentUserMessages).toEqual([{ prompt: "Idle message" }]);

    const busy = harness(false);
    await busy.emit("session_start", { type: "session_start", reason: "startup" });
    await busy.deliver("Busy message");
    expect(busy.sentUserMessages).toEqual([{ prompt: "Busy message", deliverAs: "followUp" }]);
    await busy.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
    expect(busy.receiverStops()).toBe(1);
  });

  it("replaces a stale receiver when Pi re-evaluates the extension", async () => {
    const firstInstance = harness(true, "shared-session");
    const reloadedInstance = harness(true, "shared-session");

    await firstInstance.emit("session_start", { type: "session_start", reason: "startup" });
    await reloadedInstance.emit("session_start", { type: "session_start", reason: "reload" });

    expect(firstInstance.receiverStops()).toBe(1);
    expect(reloadedInstance.receiverStops()).toBe(0);

    await reloadedInstance.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
    expect(reloadedInstance.receiverStops()).toBe(1);
  });
});
