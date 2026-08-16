import type { TranscriptEntry } from "@overfactor/sdk";
import { describe, expect, it } from "vitest";
import {
  groupTranscriptEntries,
  summarizeToolCalls,
} from "../src/renderer/src/lib/transcript-groups.ts";

function call(id: string, name: string): TranscriptEntry {
  return {
    id: `call-${id}`,
    role: "tool",
    markdown: "```json\n{}\n```",
    toolName: name,
    toolCallId: id,
    toolPhase: "call",
  };
}

function result(id: string, name: string): TranscriptEntry {
  return {
    id: `result-${id}`,
    role: "tool",
    markdown: "```\nok\n```",
    toolName: name,
    toolCallId: id,
    toolPhase: "result",
  };
}

describe("groupTranscriptEntries", () => {
  it("collapses a completed consecutive tool chain", () => {
    const items = groupTranscriptEntries(
      [
        call("1", "Bash"),
        call("2", "Bash"),
        call("3", "read"),
        result("1", "Bash"),
        result("2", "Bash"),
        result("3", "read"),
      ],
      true,
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ type: "tool-group" });
    if (items[0]?.type !== "tool-group") throw new Error("expected a tool group");
    expect(items[0].calls).toHaveLength(3);
    expect(items[0].entries).toHaveLength(6);
    expect(summarizeToolCalls(items[0].calls)).toBe("Bash ×2, read ×1");
  });

  it("keeps the final in-progress call visible", () => {
    const active = call("3", "read");
    const items = groupTranscriptEntries(
      [call("1", "Bash"), call("2", "Bash"), active, result("1", "Bash"), result("2", "Bash")],
      true,
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ type: "tool-group" });
    expect(items[1]).toEqual({ type: "entry", entry: active });
    if (items[0]?.type !== "tool-group") throw new Error("expected a tool group");
    expect(summarizeToolCalls(items[0].calls)).toBe("Bash ×2");
    expect(items[0].entries).not.toContain(active);
  });

  it("leaves a single tool call ungrouped", () => {
    const single = call("1", "read");
    expect(groupTranscriptEntries([single], true)).toEqual([{ type: "entry", entry: single }]);
  });

  it("collapses an unmatched tail call once the session is no longer active", () => {
    const items = groupTranscriptEntries([call("1", "Bash"), call("2", "read")], false);

    expect(items).toHaveLength(1);
    if (items[0]?.type !== "tool-group") throw new Error("expected a tool group");
    expect(items[0].calls).toHaveLength(2);
  });

  it("does not treat an unmatched historical call as in progress", () => {
    const assistant: TranscriptEntry = { id: "a", role: "assistant", markdown: "Done" };
    const items = groupTranscriptEntries([call("1", "Bash"), call("2", "read"), assistant], true);

    expect(items.map((item) => item.type)).toEqual(["tool-group", "entry"]);
    if (items[0]?.type !== "tool-group") throw new Error("expected a tool group");
    expect(items[0].calls).toHaveLength(2);
  });

  it("starts a new group after a conversational entry", () => {
    const assistant: TranscriptEntry = { id: "a", role: "assistant", markdown: "Next" };
    const items = groupTranscriptEntries(
      [
        call("1", "read"),
        result("1", "read"),
        assistant,
        call("2", "Bash"),
        call("3", "Bash"),
        result("2", "Bash"),
        result("3", "Bash"),
      ],
      true,
    );

    expect(items.map((item) => item.type)).toEqual(["entry", "entry", "entry", "tool-group"]);
  });
});
