import type { DaemonInfo, HookEvent } from "@overfactor/sdk";
import { describe, expect, it, vi } from "vitest";
import { postHookEvent } from "../src/node.ts";

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
