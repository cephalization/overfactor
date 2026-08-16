import type { TranscriptEntry } from "@overfactor/sdk";

export type TranscriptRenderItem =
  | { type: "entry"; entry: TranscriptEntry }
  | {
      type: "tool-group";
      id: string;
      entries: TranscriptEntry[];
      calls: TranscriptEntry[];
    };

function isToolCall(entry: TranscriptEntry): boolean {
  return entry.role === "tool" && entry.toolPhase === "call";
}

function finalCallIsInProgress(chain: TranscriptEntry[], finalCall: TranscriptEntry): boolean {
  if (finalCall.toolCallId === undefined) return false;
  return !chain.some(
    (entry) => entry.toolPhase === "result" && entry.toolCallId === finalCall.toolCallId,
  );
}

function groupToolChain(
  chain: TranscriptEntry[],
  canHaveActiveTail: boolean,
): TranscriptRenderItem[] {
  const calls = chain.filter(isToolCall);
  if (calls.length < 2) return chain.map((entry) => ({ type: "entry", entry }));

  const finalCall = calls.at(-1);
  if (finalCall === undefined) return chain.map((entry) => ({ type: "entry", entry }));

  const hasActiveFinalCall = canHaveActiveTail && finalCallIsInProgress(chain, finalCall);
  const groupedCalls = hasActiveFinalCall ? calls.slice(0, -1) : calls;
  const groupedEntries = hasActiveFinalCall
    ? chain.filter((entry) => entry.id !== finalCall.id)
    : chain;

  const items: TranscriptRenderItem[] = [
    {
      type: "tool-group",
      id: `tool-group:${calls[0]?.id ?? chain[0]?.id ?? "unknown"}`,
      entries: groupedEntries,
      calls: groupedCalls,
    },
  ];
  if (hasActiveFinalCall) items.push({ type: "entry", entry: finalCall });
  return items;
}

/** Collapse adjacent tool invocations/results into stable render groups. */
export function groupTranscriptEntries(
  entries: TranscriptEntry[],
  sessionCanBeActive: boolean,
): TranscriptRenderItem[] {
  const items: TranscriptRenderItem[] = [];
  let index = 0;

  while (index < entries.length) {
    const entry = entries[index];
    if (entry?.role !== "tool") {
      if (entry !== undefined) items.push({ type: "entry", entry });
      index += 1;
      continue;
    }

    let end = index + 1;
    while (entries[end]?.role === "tool") end += 1;
    items.push(
      ...groupToolChain(entries.slice(index, end), sessionCanBeActive && end === entries.length),
    );
    index = end;
  }

  return items;
}

/** Tool counts in first-seen order for the compact divider label. */
export function summarizeToolCalls(calls: TranscriptEntry[]): string {
  const counts = new Map<string, number>();
  for (const call of calls) {
    const name = call.toolName ?? "tool";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, count]) => `${name} ×${count}`).join(", ");
}
