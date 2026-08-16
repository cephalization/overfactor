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
    expect(entries[2]).toMatchObject({ toolName: "Bash" });
    expect(entries[2]?.markdown).toContain('"command":"ls"');
    expect(entries[3]).toMatchObject({ toolName: "Bash" });
    expect(entries[3]?.markdown).toContain("file.ts");
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

describe("extractSessionTitle", () => {
  it("returns the last ai-title, or null when absent", async () => {
    const { extractSessionTitle } = await import("../src/transcript.ts");
    const content = [
      JSON.stringify({ type: "ai-title", aiTitle: "First title" }),
      JSON.stringify({ type: "user", uuid: "u1", message: { content: "hi" } }),
      JSON.stringify({ type: "ai-title", aiTitle: "Refined title" }),
    ].join("\n");
    expect(extractSessionTitle(content)).toBe("Refined title");
    expect(extractSessionTitle("")).toBeNull();
  });
});
