import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HookEvent } from "@overfactor/sdk";
import { describe, expect, it } from "vitest";
import { registerPiIntegration } from "../src/index.ts";
import type { HookEventSink } from "../src/transport.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;

function harness(idle = true) {
  const handlers = new Map<string, Handler>();
  const reported: HookEvent[] = [];
  const pi = {
    on(event: string, handler: unknown) {
      handlers.set(event, handler as Handler);
    },
  } as unknown as ExtensionAPI;
  const sink: HookEventSink = {
    async send(event) {
      reported.push(event);
    },
  };
  const ctx = {
    cwd: "/repo",
    isIdle: () => idle,
    sessionManager: {
      getSessionId: () => "pi-session-1",
      getSessionFile: () => "/sessions/pi-session-1.jsonl",
    },
  } as unknown as ExtensionContext;

  registerPiIntegration(pi, sink);

  async function emit(name: string, event: unknown): Promise<void> {
    const handler = handlers.get(name);
    if (handler === undefined) throw new Error(`missing ${name} handler`);
    await handler(event, ctx);
  }

  return { emit, reported };
}

describe("registerPiIntegration", () => {
  it("reports the Pi lifecycle and ignores extension-only reload shutdowns", async () => {
    const { emit, reported } = harness();

    await emit("session_start", { type: "session_start", reason: "startup" });
    await emit("before_agent_start", {
      type: "before_agent_start",
      prompt: "Fix the bug",
      systemPrompt: "",
      systemPromptOptions: {},
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
});
