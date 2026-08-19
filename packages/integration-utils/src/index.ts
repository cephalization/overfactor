import { spawn } from "node:child_process";
import type { ReviewEngineRequest, ReviewEngineResult } from "@overfactor/sdk";
import { reviewEngineResultSchema } from "@overfactor/sdk";

/** Shared limits for one-shot review-agent invocations. */
export const DEFAULT_REVIEW_TIMEOUT_MS = 10 * 60 * 1000;
export const REVIEW_ENGINE_AVAILABILITY_TIMEOUT_MS = 10 * 1000;
export const MAX_REVIEW_PROCESS_ERROR_CHARS = 500;

/** Budget for file bodies inside `<diff>`; the always-complete manifest is extra. */
const MAX_PATCH_CHARS = 150_000;

export interface CliRunOptions {
  command: string;
  args: string[];
  stdin: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

/** Dependency-free subprocess runner shared by one-shot harness integrations. */
export function runCli(options: CliRunOptions): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(options.command, options.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: options.env ?? process.env,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill("SIGKILL");
      rejectPromise(
        new Error(`${options.command} timed out after ${Math.round(options.timeoutMs / 1000)}s`),
      );
    }, options.timeoutMs);

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
      else {
        rejectPromise(
          new Error(
            `${options.command} exited ${code}: ${stderr.slice(-MAX_REVIEW_PROCESS_ERROR_CHARS)}`,
          ),
        );
      }
    });
    child.stdin.end(options.stdin);
  });
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
  const chunks = patch
    .split(/(?=^diff --git )/m)
    .filter((chunk) => chunk.startsWith("diff --git "));
  for (const chunk of chunks) {
    const newlineAt = chunk.indexOf("\n");
    const header = newlineAt === -1 ? chunk : chunk.slice(0, newlineAt);
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

/** Diff bodies that spend tokens without helping the grouping decision. */
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

/** Renders a complete file manifest plus whole-file diff bodies within a fixed budget. */
export function renderPatchForReview(patch: string): RenderedPatch {
  const sections = splitPatchByFile(patch);
  const manifest = sections
    .map((section) => `${section.status} +${section.added} -${section.removed} ${section.path}`)
    .join("\n");

  let budget = MAX_PATCH_CHARS;
  let omittedCount = 0;
  const rendered = sections.map((section) => {
    const noise =
      section.status === "D" || BODY_NOISE_PATTERNS.some((pattern) => pattern.test(section.path));
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

/** Builds the harness-neutral guided-review prompt. */
export function buildReviewPrompt(
  request: ReviewEngineRequest,
  previousError: string | null,
): string {
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

/** Extracts and validates the first JSON object from a harness's final text. */
export function extractReviewResult(textOutput: string): ReviewEngineResult {
  let text = textOutput.trim();
  const fenced = /^```(?:json)?\n([\s\S]*?)\n```$/.exec(text);
  if (fenced?.[1] !== undefined) text = fenced[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("response contained no JSON object");
  }
  return reviewEngineResultSchema.parse(JSON.parse(text.slice(start, end + 1)));
}

export type ReviewPromptInvoker = (prompt: string) => Promise<string>;

/** Runs a shared prompt with one correction retry when structured output is invalid. */
export async function generateReviewWithPrompt(
  request: ReviewEngineRequest,
  invoke: ReviewPromptInvoker,
): Promise<ReviewEngineResult> {
  let lastError: string | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const output = await invoke(buildReviewPrompt(request, lastError));
    try {
      return extractReviewResult(output);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  throw new Error(`review output failed validation: ${lastError ?? "unknown"}`);
}
