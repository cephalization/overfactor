import type { TranscriptEntry } from "@overfactor/sdk";
import { z } from "zod";

/**
 * Parses Claude Code's JSONL transcript into neutral entries. Loose schemas
 * throughout: the format grows fields between releases and we consume only
 * what we render. Meta lines (task notifications, caveats) and sidechain
 * (subagent) lines are skipped; thinking blocks are omitted.
 */

const MAX_ENTRY_LENGTH = 4000;
const MAX_TOOL_INPUT_LENGTH = 600;

const contentBlockSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  name: z.string().optional(),
  id: z.string().optional(),
  input: z.unknown().optional(),
  tool_use_id: z.string().optional(),
  content: z.unknown().optional(),
});
type ContentBlock = z.infer<typeof contentBlockSchema>;

const lineSchema = z.looseObject({
  type: z.string(),
  uuid: z.string().optional(),
  timestamp: z.string().optional(),
  isMeta: z.boolean().optional(),
  isSidechain: z.boolean().optional(),
  message: z
    .looseObject({
      role: z.string().optional(),
      content: z.union([z.string(), z.array(contentBlockSchema)]).optional(),
    })
    .optional(),
});

function truncate(text: string, max = MAX_ENTRY_LENGTH): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}\n…`;
}

function isoTimestamp(value: string | undefined): string | undefined {
  return value !== undefined && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function flattenToolResult(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        const parsed = contentBlockSchema.safeParse(block);
        return parsed.success && parsed.data.type === "text" ? (parsed.data.text ?? "") : "";
      })
      .join("\n");
  }
  return "";
}

function toolUseMarkdown(input: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? "";
  } catch {
    serialized = "";
  }
  return `\`\`\`json\n${truncate(serialized, MAX_TOOL_INPUT_LENGTH)}\n\`\`\``;
}

export function parseClaudeTranscript(content: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const toolNames = new Map<string, string>();
  let lineNumber = 0;

  for (const rawLine of content.split("\n")) {
    lineNumber += 1;
    if (rawLine.trim() === "") continue;
    let parsed: z.infer<typeof lineSchema>;
    try {
      parsed = lineSchema.parse(JSON.parse(rawLine));
    } catch {
      continue;
    }
    if (parsed.type !== "user" && parsed.type !== "assistant") continue;
    if (parsed.isMeta === true || parsed.isSidechain === true) continue;

    const id = parsed.uuid ?? `line-${lineNumber}`;
    const timestamp = isoTimestamp(parsed.timestamp);
    const messageContent = parsed.message?.content;

    if (typeof messageContent === "string") {
      if (messageContent.trim() === "") continue;
      entries.push({ id, role: "user", markdown: truncate(messageContent), timestamp });
      continue;
    }
    if (!Array.isArray(messageContent)) continue;

    messageContent.forEach((block: ContentBlock, index) => {
      const entryId = `${id}:${index}`;
      if (block.type === "text" && block.text !== undefined && block.text.trim() !== "") {
        entries.push({
          id: entryId,
          role: parsed.type === "assistant" ? "assistant" : "user",
          markdown: truncate(block.text),
          timestamp,
        });
      } else if (block.type === "tool_use" && block.name !== undefined) {
        if (block.id !== undefined) toolNames.set(block.id, block.name);
        entries.push({
          id: entryId,
          role: "tool",
          toolName: block.name,
          toolCallId: block.id,
          toolPhase: "call",
          markdown: toolUseMarkdown(block.input),
          timestamp,
        });
      } else if (block.type === "tool_result") {
        const text = flattenToolResult(block.content);
        entries.push({
          id: entryId,
          role: "tool",
          toolName: block.tool_use_id !== undefined ? toolNames.get(block.tool_use_id) : undefined,
          toolCallId: block.tool_use_id,
          toolPhase: "result",
          markdown:
            text.trim() === ""
              ? "_No output._"
              : `\`\`\`\n${truncate(text, MAX_TOOL_INPUT_LENGTH)}\n\`\`\``,
          timestamp,
        });
      }
    });
  }
  return entries;
}

const titleLineSchema = z.looseObject({ type: z.string(), aiTitle: z.string().optional() });

/** Claude Code's own generated session title (last `ai-title` line), if any. */
export function extractSessionTitle(content: string): string | null {
  let title: string | null = null;
  for (const rawLine of content.split("\n")) {
    if (!rawLine.includes('"ai-title"')) continue;
    try {
      const parsed = titleLineSchema.parse(JSON.parse(rawLine));
      if (
        parsed.type === "ai-title" &&
        parsed.aiTitle !== undefined &&
        parsed.aiTitle.trim() !== ""
      ) {
        title = parsed.aiTitle.trim();
      }
    } catch {
      continue;
    }
  }
  return title;
}
