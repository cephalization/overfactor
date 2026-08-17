import type { DaemonInfo, HookEvent } from "@overfactor/sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createHookEventSink } from "../src/transport.ts";

const daemonInfo: DaemonInfo = {
  port: 41417,
  pid: 123,
  startedAt: "2026-08-15T12:00:00.000Z",
  version: "0.0.0",
};

const stoppedEvent: HookEvent = {
  type: "stopped",
  sessionId: "pi-session-1",
  agent: "pi",
  cwd: "/repo",
};

describe("createHookEventSink", () => {
  it("posts validated events to the discovered daemon", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    const sink = createHookEventSink({
      readDaemonInfo: async () => daemonInfo,
      fetch: fetchMock,
    });

    await sink.send(stoppedEvent);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("http://127.0.0.1:41417/events");
    expect(init).toMatchObject({ method: "POST" });
    const body = z.string().parse(init?.body);
    expect(JSON.parse(body)).toEqual(stoppedEvent);
  });

  it("drops events silently when the daemon is absent", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const sink = createHookEventSink({
      readDaemonInfo: async () => null,
      fetch: fetchMock,
    });

    await expect(sink.send(stoppedEvent)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("continues delivering later events after a transport failure", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("daemon restarted"))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    const sink = createHookEventSink({
      readDaemonInfo: async () => daemonInfo,
      fetch: fetchMock,
    });

    await sink.send(stoppedEvent);
    await sink.send({ ...stoppedEvent, type: "activity" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
