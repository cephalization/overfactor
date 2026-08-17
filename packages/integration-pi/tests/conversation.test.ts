import type { ConversationMessage } from "@overfactor/sdk";
import { describe, expect, it, vi } from "vitest";
import { createConversationMessageReceiver } from "../src/conversation.ts";

const message: ConversationMessage = {
  id: "00000000-0000-4000-8000-000000000000",
  prompt: "Continue",
  createdAt: "2026-08-16T12:00:00.000Z",
};

describe("createConversationMessageReceiver", () => {
  it("does not re-deliver a message while retrying a failed acknowledgement", async () => {
    const readMessage = vi
      .fn<(sessionId: string) => Promise<ConversationMessage | null>>()
      .mockResolvedValueOnce(message)
      .mockResolvedValue(null);
    const acknowledgeMessage = vi
      .fn<(sessionId: string, messageId: string) => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("daemon restarted"))
      .mockResolvedValue(true);
    const onMessage = vi.fn(async () => undefined);
    const receiver = createConversationMessageReceiver({
      readMessage,
      acknowledgeMessage,
      pollIntervalMs: 1,
    });

    const stop = receiver.subscribe("pi-session-1", onMessage);
    await vi.waitFor(() => expect(acknowledgeMessage).toHaveBeenCalledTimes(2));
    stop();

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(message);
    expect(readMessage).toHaveBeenCalled();
  });

  it("acks and drops a message whose delivery keeps failing, then moves on", async () => {
    const nextMessage: ConversationMessage = {
      ...message,
      id: "00000000-0000-4000-8000-000000000001",
    };
    const acknowledgeMessage = vi
      .fn<(sessionId: string, messageId: string) => Promise<boolean>>()
      .mockResolvedValue(true);
    // The poison message stays at the head of the queue until it is acked.
    const readMessage = vi
      .fn<(sessionId: string) => Promise<ConversationMessage | null>>()
      .mockImplementation(async () =>
        acknowledgeMessage.mock.calls.length === 0 ? message : nextMessage,
      );
    const onMessage = vi.fn(async (delivered: ConversationMessage) => {
      if (delivered.id === message.id) throw new Error("sendUserMessage failed");
    });
    const receiver = createConversationMessageReceiver({
      readMessage,
      acknowledgeMessage,
      pollIntervalMs: 1,
    });

    const stop = receiver.subscribe("pi-session-1", onMessage);
    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith(nextMessage));
    stop();

    expect(onMessage.mock.calls.filter(([m]) => m.id === message.id)).toHaveLength(3);
    expect(acknowledgeMessage).toHaveBeenCalledWith("pi-session-1", message.id);
  });
});
