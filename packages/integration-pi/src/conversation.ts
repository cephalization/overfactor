import type { ConversationMessage } from "@overfactor/sdk";
import { acknowledgeConversationMessage, readConversationMessage } from "@overfactor/sdk/node";

const POLL_INTERVAL_MS = 500;
const MAX_DELIVERY_ATTEMPTS = 3;

export interface ConversationMessageReceiver {
  subscribe(
    sessionId: string,
    onMessage: (message: ConversationMessage) => void | Promise<void>,
  ): () => void;
}

export interface ConversationReceiverDependencies {
  readMessage: (sessionId: string) => Promise<ConversationMessage | null>;
  acknowledgeMessage: (sessionId: string, messageId: string) => Promise<boolean>;
  pollIntervalMs?: number;
}

const defaultDependencies: ConversationReceiverDependencies = {
  readMessage: readConversationMessage,
  acknowledgeMessage: (sessionId, messageId) =>
    acknowledgeConversationMessage(sessionId, { messageId }),
};

interface InflightMessage {
  message: ConversationMessage;
  attempts: number;
  delivered: boolean;
}

/**
 * Polls Overfactor's per-session inbox from Pi's long-lived extension runtime.
 * A delivered message is acknowledged before another one is read, preventing a
 * transient acknowledgement failure from immediately re-sending it. A message
 * whose delivery keeps failing is acknowledged (dropped) after
 * MAX_DELIVERY_ATTEMPTS so it cannot block the session's FIFO queue forever.
 */
export function createConversationMessageReceiver(
  dependencies: ConversationReceiverDependencies = defaultDependencies,
): ConversationMessageReceiver {
  return {
    subscribe(sessionId, onMessage) {
      let stopped = false;
      let timer: NodeJS.Timeout | undefined;
      let inflight: InflightMessage | null = null;

      const schedule = (): void => {
        if (stopped) return;
        timer = setTimeout(() => void poll(), dependencies.pollIntervalMs ?? POLL_INTERVAL_MS);
        timer.unref();
      };

      const drop = async (message: ConversationMessage): Promise<void> => {
        // Acknowledge to delete the poison message from the daemon queue. A
        // false result means the daemon/session no longer owns it (for example
        // after a restart), so it is gone either way.
        await dependencies.acknowledgeMessage(sessionId, message.id);
        inflight = null;
      };

      const poll = async (): Promise<void> => {
        try {
          if (inflight?.delivered === true) {
            await drop(inflight.message);
            return;
          }
          const message = await dependencies.readMessage(sessionId);
          if (message === null || stopped) return;
          if (inflight?.message.id !== message.id) {
            inflight = { message, attempts: 0, delivered: false };
          }
          inflight.attempts += 1;
          if (inflight.attempts > MAX_DELIVERY_ATTEMPTS) {
            if (process.env.OVERFACTOR_DEBUG !== undefined) {
              console.error(
                `[overfactor] dropping message ${message.id} after ${MAX_DELIVERY_ATTEMPTS} failed deliveries`,
              );
            }
            await drop(message);
            return;
          }
          await onMessage(message);
          inflight.delivered = true;
          const acknowledged = await dependencies.acknowledgeMessage(sessionId, message.id);
          if (acknowledged) inflight = null;
        } catch (error) {
          // Overfactor is optional: daemon absence/restarts and message
          // delivery failures must never affect Pi. Keep diagnostics opt-in.
          if (process.env.OVERFACTOR_DEBUG !== undefined) {
            console.error("[overfactor] conversation delivery failed:", error);
          }
        } finally {
          schedule();
        }
      };

      void poll();
      return () => {
        stopped = true;
        if (timer !== undefined) clearTimeout(timer);
      };
    },
  };
}
