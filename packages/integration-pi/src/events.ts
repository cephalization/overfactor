import type { HookEvent } from "@overfactor/sdk";

export interface PiSessionIdentity {
  sessionId: string;
  cwd: string;
  transcriptPath: string | null;
}

function base(identity: PiSessionIdentity) {
  return {
    sessionId: identity.sessionId,
    agent: "pi" as const,
    cwd: identity.cwd,
  };
}

export function sessionStartEvent(identity: PiSessionIdentity): HookEvent {
  return {
    type: "session-start",
    ...base(identity),
    transcriptPath: identity.transcriptPath,
  };
}

export function userPromptEvent(identity: PiSessionIdentity, prompt: string): HookEvent {
  return { type: "user-prompt", ...base(identity), prompt };
}

export function activityEvent(identity: PiSessionIdentity, tool?: string): HookEvent {
  if (tool === undefined) return { type: "activity", ...base(identity) };
  return { type: "activity", ...base(identity), tool };
}

export function stoppedEvent(identity: PiSessionIdentity): HookEvent {
  return { type: "stopped", ...base(identity) };
}

export function sessionEndEvent(identity: PiSessionIdentity, reason?: string): HookEvent {
  if (reason === undefined) return { type: "session-end", ...base(identity) };
  return { type: "session-end", ...base(identity), reason };
}
