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

// The output contract requires listing every changed file, so generation time
// scales with file count — a several-hundred-file branch exceeds 5 minutes.
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const AVAILABILITY_TIMEOUT_MS = 10 * 1000;
/** Budget for file bodies inside `<diff>`; the always-complete `<files>` manifest is extra. */
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

/** One file's slice of a unified patch: its `diff --git` header through the next header. */
interface PatchFileSection {
  /** Repo-relative path from the header's `b/` side (matches the daemon's extraction). */
  path: string;
  status: "A" | "D" | "M";
  added: number;
  removed: number;
  /** Full chunk text, header included. */
  text: string;
}

function splitPatchByFile(patch: string): PatchFileSection[] {
  const sections: PatchFileSection[] = [];
  // Split keeping the headers: each chunk starts at its `diff --git` line.
  const chunks = patch
    .split(/(?=^diff --git )/m)
    .filter((chunk) => chunk.startsWith("diff --git "));
  for (const chunk of chunks) {
    const newlineAt = chunk.indexOf("\n");
    const header = newlineAt === -1 ? chunk : chunk.slice(0, newlineAt);
    // Same extraction as the daemon's changedFilesFromPatch, so manifest paths
    // validate against the changed-file list the review is normalized with.
    const bSide = / b\/(.+)$/.exec(header)?.[1] ?? / "b\/(.+)"$/.exec(header)?.[1];
    if (bSide === undefined) continue;
    let added = 0;
    let removed = 0;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
      if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
    }
    sections.push({
      path: bSide.replace(/^"|"$/g, ""),
      status: chunk.includes("\ndeleted file mode")
        ? "D"
        : chunk.includes("\nnew file mode")
          ? "A"
          : "M",
      added,
      removed,
      text: chunk,
    });
  }
  return sections;
}

/**
 * Paths whose diff bodies are mechanical noise — the path and status already
 * say everything a grouping decision needs (mirrors the renderer's
 * diff-noise heuristics). Their bodies never spend patch budget.
 */
const BODY_NOISE_PATTERNS = [
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|poetry\.lock|Cargo\.lock|Gemfile\.lock)$/,
  /(?:^|\/)__generated__\//,
];

export interface RenderedPatch {
  /** Every changed file with status and line counts — complete, never truncated. */
  manifest: string;
  /** Per-file diff bodies within budget; omitted bodies carry explicit stubs. */
  diff: string;
  /** Files whose body was omitted (deleted, noise, or over budget). */
  omittedCount: number;
}

/**
 * Render the patch for the prompt. A flat character slice is misleading: the
 * cut lands mid-file at an arbitrary (alphabetical) point, the model groups
 * only what it sees, and every later file lands in the catch-all sweep — on a
 * large branch that is most of the change. Instead, the manifest always lists
 * every file, deleted/noise bodies are always collapsed, and remaining bodies
 * are included whole-file until the budget runs out, with stubs marking every
 * omission so the model still groups those files by path, status, and size.
 */
export function renderPatchForReview(patch: string): RenderedPatch {
  const sections = splitPatchByFile(patch);
  const manifest = sections
    .map((section) => `${section.status} +${section.added} -${section.removed} ${section.path}`)
    .join("\n");

  let budget = MAX_PATCH_CHARS;
  let omittedCount = 0;
  const rendered = sections.map((section) => {
    const noise = section.status === "D" || BODY_NOISE_PATTERNS.some((p) => p.test(section.path));
    const header = section.text.slice(0, section.text.indexOf("\n"));
    if (noise) {
      omittedCount += 1;
      const reason = section.status === "D" ? "deleted file" : "generated/lockfile content";
      return `${header}\n[... body omitted: ${reason} — group by path and status ...]\n`;
    }
    if (section.text.length <= budget) {
      budget -= section.text.length;
      return section.text;
    }
    omittedCount += 1;
    return `${header}\n[... body omitted for length (+${section.added} -${section.removed}) — group by path, status, and size ...]\n`;
  });

  return { manifest, diff: rendered.join(""), omittedCount };
}

function buildPrompt(request: ReviewEngineRequest, previousError: string | null): string {
  const rendered = renderPatchForReview(request.patch);

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
- Produce 2 to 6 steps ("groups") for a small change; a large one (hundreds of files) may need up to 10. Prefer one more real step over a catch-all. Each step is a chapter of the review in the order the reviewer should read them.
- Step 1 is the change this branch exists to make — the one the branch or change-request title names, or the one the other changes exist to support. Hardening fixes, small robustness tweaks, and enabling refactors that merely serve the core come AFTER it; a two-file fix is never step 1 of a large change. Follow with the code that adopts or wires the core, then its tests. Mechanical churn (renames, lockfiles, generated output, formatting, import shuffles, trivial config) goes LAST in a single step named for what it is (e.g. "Supporting changes") so the reviewer can skim it with low attention.
- Name each step like a short commit subject describing what it does — never a directory name or a vague label like "Miscellaneous".
- Each summary is 2-4 sentences addressed to the reviewer: what this step changes and why, then what to verify — the invariant that must hold, the edge case that could break, or the decision worth questioning. Do not narrate the diff line by line; say where a bug would hide.
- <files> lists EVERY changed file with its status (A added, M modified, D deleted) and line counts, and is never truncated. Every one of those files appears in exactly one step, with paths exactly as listed there — including files whose diff body is omitted. Group body-less files by path, status, and the step whose area they belong to; a deleted file belongs with the step that retires or replaces it.
- In <diff>, an omitted body is marked with a stub line. Never invent what an omitted body contains; reason from its path, status, counts, and the intent.
- Keep one behavior's source, wiring, and config together in one step; a file belongs with the step it matters to most.
- Respond with ONLY this JSON shape, no prose and no code fences:
  {"groups":[{"name":"...","summary":"...","files":["path/one.ts"]}]}`,
  ];
  if (intentLines.length > 0) {
    sections.push(`<intent>\n${intentLines.join("\n")}\n</intent>`);
  }
  if (request.previousGroups !== null && request.previousGroups.length > 0) {
    sections.push(
      `<previous-groups>\nA prior review grouped this change as follows. Preserve the names and membership of groups whose files did not change — the reviewer's progress markers are keyed to them. But a prior group that violates the rules above (a catch-all like "Everything else", mechanical churn mixed into a behavioral step, a supporting fix ordered ahead of the core change) is fair to restructure even when its files did not move.\n${JSON.stringify({ groups: request.previousGroups })}\n</previous-groups>`,
    );
  }
  if (previousError !== null) {
    sections.push(
      `Your previous response was rejected: ${previousError}. Respond again with ONLY the JSON object.`,
    );
  }
  sections.push(`<files>\n${rendered.manifest}\n</files>`);
  const diffNote =
    rendered.omittedCount > 0
      ? `\n(${rendered.omittedCount} file${rendered.omittedCount === 1 ? "" : "s"} shown as stubs; all are listed in <files> and must still be grouped.)\n`
      : "\n";
  sections.push(`<diff>${diffNote}${rendered.diff}</diff>`);
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
