import { spawn } from "node:child_process";
import type { ReviewEngineRequest, ReviewEngineResult } from "@overfactor/sdk";
import { reviewEngineResultSchema } from "@overfactor/sdk";
import { z } from "zod";

/**
 * Curated-review engine for Claude Code: spawns the user's own `claude -p`
 * (piggybacking their existing login — no API keys, same posture as
 * gh→octokit) and validates the structured grouping it returns. Invocation
 * knowledge lives here, beside the rest of this harness's integration, so it
 * is maintained like the plugin itself.
 */

/**
 * Reviews always pin a model rather than inheriting the CLI default — a user
 * whose default is a top-tier model should not silently pay top-tier rates
 * for review generation. The alias tracks the latest Sonnet, which is ample
 * for structured grouping and guidance. A settings-level policy overrides it.
 */
export const DEFAULT_REVIEW_MODEL = "sonnet";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const AVAILABILITY_TIMEOUT_MS = 10 * 1000;
const MAX_PATCH_CHARS = 150_000;
const MAX_STDERR_CHARS = 500;

/** Runs the claude CLI; injectable so tests never spawn a real agent. */
export type ClaudeCliRunner = (args: string[], stdin: string, timeoutMs: number) => Promise<string>;

const runClaudeCli: ClaudeCliRunner = (args, stdin, timeoutMs) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
      // The engine run is plumbing, not a user session: point the hook shim's
      // daemon discovery at a path that cannot exist so its own SessionStart/
      // Stop events are dropped instead of appearing in the app.
      env: { ...process.env, OVERFACTOR_DIR: "/nonexistent/overfactor-review-engine" },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      rejectPromise(new Error(`claude timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`claude exited ${code}: ${stderr.slice(-MAX_STDERR_CHARS)}`));
    });
    child.stdin.end(stdin);
  });

/** The slice of `claude -p --output-format json` output we consume. */
const printOutputSchema = z.looseObject({
  result: z.string(),
  is_error: z.boolean().optional(),
});

export interface ClaudeReviewOptions {
  model?: string | null;
  timeoutMs?: number;
  run?: ClaudeCliRunner;
}

function buildPrompt(request: ReviewEngineRequest, previousError: string | null): string {
  const patch =
    request.patch.length > MAX_PATCH_CHARS
      ? `${request.patch.slice(0, MAX_PATCH_CHARS)}\n[... diff truncated for length ...]`
      : request.patch;

  const intentLines = [
    request.intent.branch === null ? null : `Branch: ${request.intent.branch}`,
    request.intent.crTitle === null ? null : `Change request: ${request.intent.crTitle}`,
    request.intent.sessionTitles.length === 0
      ? null
      : `Agent session titles (what was asked for):\n${request.intent.sessionTitles
          .map((title) => `- ${title}`)
          .join("\n")}`,
  ].filter((line) => line !== null);

  const sections = [
    `You are writing a GUIDED code review: an ordered walkthrough that tells a reviewer where to start, what each step changes, and what deserves scrutiny. You are the reviewer's senior colleague pointing at the parts that matter — not a changelog generator.

Rules:
- Produce 2 to 6 steps ("groups"), each a chapter of the review in the order the reviewer should read them.
- Order steps as a review path: the core behavioral or data-model change first, then the code that adopts or wires it, then tests. Mechanical churn (renames, lockfiles, generated output, formatting, import shuffles, trivial config) goes LAST in a single step named for what it is (e.g. "Supporting changes") so the reviewer can skim it with low attention.
- Name each step like a short commit subject describing what it does — never a directory name or a vague label like "Miscellaneous".
- Each summary is 2-4 sentences addressed to the reviewer: what this step changes and why, then what to verify — the invariant that must hold, the edge case that could break, or the decision worth questioning. Do not narrate the diff line by line; say where a bug would hide.
- Every changed file appears in exactly one step. Use paths exactly as they appear after "b/" in the diff headers.
- Keep one behavior's source, wiring, and config together in one step; a file belongs with the step it matters to most.
- Respond with ONLY this JSON shape, no prose and no code fences:
  {"groups":[{"name":"...","summary":"...","files":["path/one.ts"]}]}`,
  ];
  if (intentLines.length > 0) {
    sections.push(`<intent>\n${intentLines.join("\n")}\n</intent>`);
  }
  if (request.previousGroups !== null && request.previousGroups.length > 0) {
    sections.push(
      `<previous-groups>\nA prior review grouped this change as follows. Preserve the names and membership of groups whose files did not change; restructure only where the diff moved.\n${JSON.stringify({ groups: request.previousGroups })}\n</previous-groups>`,
    );
  }
  if (previousError !== null) {
    sections.push(
      `Your previous response was rejected: ${previousError}. Respond again with ONLY the JSON object.`,
    );
  }
  sections.push(`<diff>\n${patch}\n</diff>`);
  return sections.join("\n\n");
}

function extractResult(stdout: string): ReviewEngineResult {
  const output = printOutputSchema.parse(JSON.parse(stdout));
  if (output.is_error === true) {
    throw new Error(`claude reported an error: ${output.result.slice(0, MAX_STDERR_CHARS)}`);
  }
  let text = output.result.trim();
  const fenced = /^```(?:json)?\n([\s\S]*?)\n```$/.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("response contained no JSON object");
  }
  return reviewEngineResultSchema.parse(JSON.parse(text.slice(start, end + 1)));
}

/** True when the `claude` CLI is installed and answers on this machine. */
export async function claudeReviewEngineAvailable(run: ClaudeCliRunner = runClaudeCli) {
  try {
    await run(["--version"], "", AVAILABILITY_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

/** Generates intent groups for a patch; one retry when the output fails validation. */
export async function generateReview(
  request: ReviewEngineRequest,
  options: ClaudeReviewOptions = {},
): Promise<ReviewEngineResult> {
  const run = options.run ?? runClaudeCli;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const args = ["-p", "--output-format", "json", "--model", options.model ?? DEFAULT_REVIEW_MODEL];

  let lastError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stdout = await run(args, buildPrompt(request, lastError), timeoutMs);
    try {
      return extractResult(stdout);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`claude review output failed validation: ${lastError ?? "unknown"}`);
}
