import { randomUUID } from "node:crypto";
import type { ConversationMessage } from "@overfactor/sdk";
import { conversationMessageSchema } from "@overfactor/sdk";

const MAX_PENDING_MESSAGES_PER_SESSION = 20;

/** Small in-memory handoff queue between the desktop app and live integrations. */
export class ConversationQueue {
  private readonly pending = new Map<string, ConversationMessage[]>();

  enqueue(sessionId: string, prompt: string): ConversationMessage | null {
    const queue = this.pending.get(sessionId) ?? [];
    if (queue.length >= MAX_PENDING_MESSAGES_PER_SESSION) return null;
    const message = conversationMessageSchema.parse({
      id: randomUUID(),
      prompt,
      createdAt: new Date().toISOString(),
    });
    queue.push(message);
    this.pending.set(sessionId, queue);
    return message;
  }

  peek(sessionId: string): ConversationMessage | null {
    return this.pending.get(sessionId)?.[0] ?? null;
  }

  acknowledge(sessionId: string, messageId: string): boolean {
    const queue = this.pending.get(sessionId);
    if (queue?.[0]?.id !== messageId) return false;
    queue.shift();
    if (queue.length === 0) this.pending.delete(sessionId);
    return true;
  }
}
