import { describe, expect, it } from "vitest";
import { parseClaudeTranscript } from "../src/transcript.ts";

function jsonl(lines: unknown[]): string {
  return lines.map((line) => JSON.stringify(line)).join("\n");
}

describe("parseClaudeTranscript", () => {
  it("parses user text, assistant text, tool use, and tool results", () => {
    const entries = parseClaudeTranscript(
      jsonl([
        { type: "mode", mode: "normal" },
        {
          type: "user",
          uuid: "u1",
          timestamp: "2026-08-16T10:00:00.000Z",
          message: { role: "user", content: "Fix the bug" },
        },
        {
          type: "assistant",
          uuid: "a1",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "hidden", signature: "x" },
              { type: "text", text: "Looking now." },
              { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
            ],
          },
        },
        {
          type: "user",
          uuid: "u2",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: "file.ts" }],
          },
        },
      ]),
    );

    expect(entries.map((e) => e.role)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(entries[0]).toMatchObject({
      markdown: "Fix the bug",
      timestamp: "2026-08-16T10:00:00.000Z",
    });
    expect(entries[2]).toMatchObject({
      toolName: "Bash",
      toolCallId: "t1",
      toolPhase: "call",
    });
    expect(entries[2]?.markdown).toContain('"command":"ls"');
    expect(entries[3]).toMatchObject({
      toolName: "Bash",
      toolCallId: "t1",
      toolPhase: "result",
    });
    expect(entries[3]?.markdown).toContain("file.ts");
  });

  it("keeps empty tool results so calls can be marked complete", () => {
    const entries = parseClaudeTranscript(
      jsonl([
        {
          type: "assistant",
          uuid: "a1",
          message: {
            content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }],
          },
        },
        {
          type: "user",
          uuid: "u1",
          message: {
            content: [{ type: "tool_result", tool_use_id: "t1", content: "" }],
          },
        },
      ]),
    );

    expect(entries[1]).toMatchObject({
      toolCallId: "t1",
      toolPhase: "result",
      markdown: "_No output._",
    });
  });

  it("keeps tool results with unfamiliar content shapes as empty results", () => {
    const entries = parseClaudeTranscript(
      jsonl([
        {
          type: "user",
          uuid: "u1",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "future-format",
                content: { output: "not understood yet" },
              },
            ],
          },
        },
      ]),
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      toolCallId: "future-format",
      toolPhase: "result",
      markdown: "_No output._",
    });
  });

  it("skips meta lines, sidechains, and malformed lines", () => {
    const entries = parseClaudeTranscript(
      [
        JSON.stringify({ type: "user", isMeta: true, message: { content: "notification" } }),
        JSON.stringify({ type: "user", isSidechain: true, message: { content: "subagent" } }),
        "not json at all",
        JSON.stringify({ type: "user", uuid: "u1", message: { content: "real message" } }),
      ].join("\n"),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.markdown).toBe("real message");
  });

  it("truncates enormous entries", () => {
    const entries = parseClaudeTranscript(
      jsonl([{ type: "user", uuid: "u1", message: { content: "x".repeat(10_000) } }]),
    );
    expect(entries[0]?.markdown.length).toBeLessThan(5_000);
    expect(entries[0]?.markdown.endsWith("…")).toBe(true);
  });
});

describe("extractSessionMetadata", () => {
  it("returns the last generated title and assistant model", async () => {
    const { extractSessionMetadata } = await import("../src/transcript.ts");
    const content = [
      JSON.stringify({ type: "ai-title", aiTitle: "First title" }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", model: "claude-sonnet-4", content: [] },
      }),
      JSON.stringify({ type: "ai-title", aiTitle: "Refined title" }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", model: "claude-fable-5", content: [] },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", model: "<synthetic>", content: [] },
      }),
    ].join("\n");
    expect(extractSessionMetadata(content)).toEqual({
      title: "Refined title",
      model: "claude-fable-5",
    });
    expect(extractSessionMetadata("")).toEqual({ title: null, model: null });
  });
});
