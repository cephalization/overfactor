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

const jsonValueSchema = z.json();
type ToolInput = z.infer<typeof jsonValueSchema>;

const toolResultBlockSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
});

const toolResultContentSchema = z.unknown().transform((content): string => {
  const text = z.string().safeParse(content);
  if (text.success) return text.data;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const parsed = toolResultBlockSchema.safeParse(block);
      return parsed.success && parsed.data.type === "text" ? (parsed.data.text ?? "") : "";
    })
    .join("\n");
});

const contentBlockSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
  name: z.string().optional(),
  id: z.string().optional(),
  input: jsonValueSchema.optional(),
  tool_use_id: z.string().optional(),
  content: toolResultContentSchema.optional(),
});
type ContentBlock = z.infer<typeof contentBlockSchema>;

interface TextMessageContent {
  kind: "text";
  text: string;
}

interface BlockMessageContent {
  kind: "blocks";
  blocks: ContentBlock[];
}

const messageContentSchema = z.union([
  z.string().transform((text): TextMessageContent => ({ kind: "text", text })),
  z.array(contentBlockSchema).transform((blocks): BlockMessageContent => ({
    kind: "blocks",
    blocks,
  })),
]);

const lineSchema = z.looseObject({
  type: z.string(),
  uuid: z.string().optional(),
  timestamp: z.string().optional(),
  isMeta: z.boolean().optional(),
  isSidechain: z.boolean().optional(),
  aiTitle: z.string().optional(),
  message: z
    .looseObject({
      role: z.string().optional(),
      model: z.string().optional(),
      content: messageContentSchema.optional(),
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

function reportedModel(value: string | undefined): string | null {
  const model = value?.trim();
  if (!model || (model.startsWith("<") && model.endsWith(">"))) return null;
  return model;
}

function toolUseMarkdown(input: ToolInput | undefined): string {
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

    if (messageContent?.kind === "text") {
      if (messageContent.text.trim() === "") continue;
      entries.push({ id, role: "user", markdown: truncate(messageContent.text), timestamp });
      continue;
    }
    if (messageContent?.kind !== "blocks") continue;

    messageContent.blocks.forEach((block: ContentBlock, index) => {
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
        const text = block.content ?? "";
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

export interface ClaudeSessionMetadata {
  title: string | null;
  model: string | null;
}

/** Claude Code's generated title and most recent assistant model, if present. */
export function extractSessionMetadata(content: string): ClaudeSessionMetadata {
  let title: string | null = null;
  let model: string | null = null;
  for (const rawLine of content.split("\n")) {
    // Cheap prefilter: only ai-title and assistant model lines carry metadata.
    // Runs on every transcript change, so full JSON parsing must stay rare.
    if (!rawLine.includes('"ai-title"') && !rawLine.includes('"model"')) continue;
    try {
      const parsed = lineSchema.parse(JSON.parse(rawLine));
      if (parsed.type === "ai-title" && parsed.aiTitle?.trim()) {
        title = parsed.aiTitle.trim();
      }
      if (parsed.type === "assistant" && parsed.message?.role === "assistant") {
        model = reportedModel(parsed.message.model) ?? model;
      }
    } catch {
      continue;
    }
  }
  return { title, model };
}
