import type { TranscriptEntry } from "@overfactor/sdk";
import { z } from "zod";

/**
 * Parses Pi's v3 session JSONL into neutral entries. Pi records `message`
 * lines (roles: user, assistant, toolResult) whose content blocks resemble
 * Anthropic's, with `toolCall` blocks for invocations, plus session metadata
 * lines. Thinking blocks and injected context (`custom_message`) are omitted;
 * compactions surface as system entries.
 */

const MAX_ENTRY_LENGTH = 4000;
const MAX_TOOL_LENGTH = 600;

const contentBlockSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  arguments: z.unknown().optional(),
});
type ContentBlock = z.infer<typeof contentBlockSchema>;

const lineSchema = z.looseObject({
  type: z.string(),
  id: z.string().optional(),
  timestamp: z.string().optional(),
  summary: z.string().optional(),
  message: z
    .looseObject({
      role: z.string().optional(),
      toolCallId: z.string().optional(),
      toolName: z.string().optional(),
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

function roleFor(piRole: string | undefined): TranscriptEntry["role"] | null {
  if (piRole === "user") return "user";
  if (piRole === "assistant") return "assistant";
  if (piRole === "toolResult") return "tool";
  return null;
}

export function parsePiTranscript(content: string): TranscriptEntry[] {
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
    const id = parsed.id ?? `line-${lineNumber}`;
    const timestamp = isoTimestamp(parsed.timestamp);

    if (parsed.type === "compaction") {
      entries.push({
        id,
        role: "system",
        markdown: `_Session compacted._\n\n${truncate(parsed.summary ?? "", MAX_TOOL_LENGTH)}`,
        timestamp,
      });
      continue;
    }
    if (parsed.type !== "message") continue;

    const role = roleFor(parsed.message?.role);
    if (role === null) continue;
    const messageContent = parsed.message?.content;
    const resultCallId = parsed.message?.toolCallId;
    const resultToolName =
      parsed.message?.toolName ??
      (resultCallId === undefined ? undefined : toolNames.get(resultCallId));

    if (typeof messageContent === "string") {
      if (messageContent.trim() === "" && role !== "tool") continue;
      entries.push({
        id,
        role,
        markdown:
          messageContent.trim() === ""
            ? "_No output._"
            : role === "tool"
              ? `\`\`\`\n${truncate(messageContent, MAX_TOOL_LENGTH)}\n\`\`\``
              : truncate(messageContent),
        ...(role === "tool"
          ? { toolName: resultToolName, toolCallId: resultCallId, toolPhase: "result" as const }
          : {}),
        timestamp,
      });
      continue;
    }
    if (!Array.isArray(messageContent)) continue;

    let resultAdded = false;
    messageContent.forEach((block: ContentBlock, index) => {
      const entryId = `${id}:${index}`;
      if (block.type === "text" && block.text !== undefined && block.text.trim() !== "") {
        const markdown =
          role === "tool"
            ? `\`\`\`\n${truncate(block.text, MAX_TOOL_LENGTH)}\n\`\`\``
            : truncate(block.text);
        entries.push({
          id: entryId,
          role,
          markdown,
          ...(role === "tool"
            ? { toolName: resultToolName, toolCallId: resultCallId, toolPhase: "result" as const }
            : {}),
          timestamp,
        });
        if (role === "tool") resultAdded = true;
      } else if (block.type === "toolCall" && block.name !== undefined) {
        let serialized: string;
        try {
          serialized = JSON.stringify(block.arguments) ?? "";
        } catch {
          serialized = "";
        }
        if (block.id !== undefined) toolNames.set(block.id, block.name);
        entries.push({
          id: entryId,
          role: "tool",
          toolName: block.name,
          toolCallId: block.id,
          toolPhase: "call",
          markdown: `\`\`\`json\n${truncate(serialized, MAX_TOOL_LENGTH)}\n\`\`\``,
          timestamp,
        });
      }
    });
    if (role === "tool" && !resultAdded) {
      entries.push({
        id: `${id}:result`,
        role: "tool",
        toolName: resultToolName,
        toolCallId: resultCallId,
        toolPhase: "result",
        markdown: "_No output._",
        timestamp,
      });
    }
  }
  return entries;
}

const sessionInfoSchema = z.looseObject({ type: z.string(), name: z.string().optional() });

/** Pi's own session name (last `session_info` line), if any. */
export function extractSessionTitle(content: string): string | null {
  let title: string | null = null;
  for (const rawLine of content.split("\n")) {
    if (!rawLine.includes('"session_info"')) continue;
    try {
      const parsed = sessionInfoSchema.parse(JSON.parse(rawLine));
      if (
        parsed.type === "session_info" &&
        parsed.name !== undefined &&
        parsed.name.trim() !== ""
      ) {
        title = parsed.name.trim();
      }
    } catch {
      continue;
    }
  }
  return title;
}
