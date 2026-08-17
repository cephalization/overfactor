import type { DaemonInfo, HookEvent } from "@overfactor/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  acknowledgeConversationMessage,
  postHookEvent,
  readConversationMessage,
} from "../src/node.ts";

const daemonInfo: DaemonInfo = {
  port: 41417,
  pid: 123,
  startedAt: "2026-08-15T12:00:00.000Z",
  version: "0.0.0",
};

const event: HookEvent = {
  type: "stopped",
  sessionId: "sess-1",
  agent: "claude-code",
  cwd: "/repo",
};

function requestUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

describe("conversation inbox helpers", () => {
  it("reads and acknowledges queued messages through daemon discovery", async () => {
    const messageId = "00000000-0000-4000-8000-000000000000";
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = requestUrl(input);
      if (url.endsWith("/messages/next")) {
        return Response.json({
          message: {
            id: messageId,
            prompt: "Continue",
            createdAt: "2026-08-16T12:00:00.000Z",
          },
        });
      }
      expect(url).toContain("/messages/ack");
      expect(init?.method).toBe("POST");
      return Response.json({ ok: true });
    });

    const dependencies = { readDaemonInfo: async () => daemonInfo, fetch: fetchMock };
    await expect(
      readConversationMessage("session/with spaces", dependencies),
    ).resolves.toMatchObject({ id: messageId, prompt: "Continue" });
    await expect(
      acknowledgeConversationMessage("session/with spaces", { messageId }, dependencies),
    ).resolves.toBe(true);
    const firstInput = fetchMock.mock.calls[0]?.[0];
    if (firstInput === undefined) throw new Error("expected a conversation poll");
    expect(requestUrl(firstInput)).toContain("session%2Fwith%20spaces");
  });

  it("treats absent daemons and stale sessions as empty inboxes", async () => {
    await expect(
      readConversationMessage("session", { readDaemonInfo: async () => null }),
    ).resolves.toBeNull();
    await expect(
      readConversationMessage("session", {
        readDaemonInfo: async () => daemonInfo,
        fetch: async () => new Response(null, { status: 404 }),
      }),
    ).resolves.toBeNull();
  });
});

describe("postHookEvent", () => {
  it("validates and posts to the discovered daemon", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    const result = await postHookEvent(event, {
      readDaemonInfo: async () => daemonInfo,
      fetch: fetchMock,
    });

    expect(result).toBe("delivered");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:41417/events");
    expect(init).toMatchObject({ method: "POST" });
    if (typeof init?.body !== "string") throw new Error("expected a JSON request body");
    expect(JSON.parse(init.body)).toEqual(event);
  });

  it("returns no-daemon without fetching when discovery fails", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const result = await postHookEvent(event, {
      readDaemonInfo: async () => null,
      fetch: fetchMock,
    });
    expect(result).toBe("no-daemon");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws on contract violations instead of posting them", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    await expect(
      postHookEvent(
        { ...event, sessionId: "" },
        {
          readDaemonInfo: async () => daemonInfo,
          fetch: fetchMock,
        },
      ),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
