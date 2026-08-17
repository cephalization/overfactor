import { describe, expect, it } from "vitest";
import { parsePiTranscript } from "../src/transcript.ts";

function jsonl(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n");
}

describe("parsePiTranscript", () => {
  it("parses messages, tool calls, tool results, and compactions", () => {
    const entries = parsePiTranscript(
      jsonl([
        { type: "session", version: 3, id: "s", timestamp: "2026-08-16T10:00:00.000Z" },
        {
          type: "message",
          id: "m1",
          timestamp: "2026-08-16T10:00:01.000Z",
          message: { role: "user", content: [{ type: "text", text: "Review #14949" }] },
        },
        {
          type: "message",
          id: "m2",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "planning", thinkingSignature: "x" },
              { type: "text", text: "On it." },
              { type: "toolCall", id: "c1", name: "read", arguments: { path: "/x.ts" } },
            ],
          },
        },
        {
          type: "message",
          id: "m3",
          message: {
            role: "toolResult",
            toolCallId: "c1",
            toolName: "read",
            content: [{ type: "text", text: "const x = 1;" }],
          },
        },
        { type: "custom_message", customType: "github-issue-context", content: "injected" },
        { type: "compaction", id: "cp1", summary: "## Goal\nShip it" },
      ]),
    );

    expect(entries.map((e) => e.role)).toEqual(["user", "assistant", "tool", "tool", "system"]);
    expect(entries[0]?.markdown).toBe("Review #14949");
    expect(entries[2]).toMatchObject({
      toolName: "read",
      toolCallId: "c1",
      toolPhase: "call",
    });
    expect(entries[3]).toMatchObject({
      toolName: "read",
      toolCallId: "c1",
      toolPhase: "result",
    });
    expect(entries[3]?.markdown).toContain("const x = 1;");
    expect(entries[4]?.markdown).toContain("Session compacted");
  });
});

describe("extractSessionMetadata", () => {
  it("returns the last session name and assistant model", async () => {
    const { extractSessionMetadata } = await import("../src/transcript.ts");
    const content = [
      JSON.stringify({ type: "session", version: 3, id: "s" }),
      JSON.stringify({ type: "session_info", id: "i1", name: "#14949 — rewind race" }),
      JSON.stringify({ type: "message", message: { role: "assistant", model: "gpt-5.5" } }),
      JSON.stringify({ type: "message", message: { role: "assistant", model: "gpt-5.6-sol" } }),
    ].join("\n");
    expect(extractSessionMetadata(content)).toEqual({
      title: "#14949 — rewind race",
      model: "gpt-5.6-sol",
    });
    expect(extractSessionMetadata("{}")).toEqual({ title: null, model: null });
  });
});
