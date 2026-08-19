import type { ReviewEngineRequest, ReviewEngineResult } from "@overfactor/sdk";
import {
  DEFAULT_REVIEW_TIMEOUT_MS,
  generateReviewWithPrompt,
  MAX_REVIEW_PROCESS_ERROR_CHARS,
  renderPatchForReview,
  REVIEW_ENGINE_AVAILABILITY_TIMEOUT_MS,
  runCli,
} from "@overfactor/integration-utils";
import { z } from "zod";

/**
 * Curated-review engine for Claude Code: spawns the user's own `claude -p`
 * and validates the shared structured walkthrough contract.
 */

/** Reviews never inherit the user's potentially expensive Claude CLI default. */
export const DEFAULT_REVIEW_MODEL = "sonnet";

/** Runs the claude CLI; injectable so tests never spawn a real agent. */
export type ClaudeCliRunner = (args: string[], stdin: string, timeoutMs: number) => Promise<string>;

const runClaudeCli: ClaudeCliRunner = (args, stdin, timeoutMs) =>
  runCli({
    command: "claude",
    args,
    stdin,
    timeoutMs,
    // The engine run is plumbing, not a user session: point the hook shim's
    // daemon discovery at a path that cannot exist so its own SessionStart/
    // Stop events are dropped instead of appearing in the app.
    env: { ...process.env, OVERFACTOR_DIR: "/nonexistent/overfactor-review-engine" },
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

function extractClaudeText(stdout: string): string {
  const output = printOutputSchema.parse(JSON.parse(stdout));
  if (output.is_error === true) {
    throw new Error(
      `claude reported an error: ${output.result.slice(0, MAX_REVIEW_PROCESS_ERROR_CHARS)}`,
    );
  }
  return output.result;
}

/** True when the `claude` CLI is installed and answers on this machine. */
export async function claudeReviewEngineAvailable(run: ClaudeCliRunner = runClaudeCli) {
  try {
    await run(["--version"], "", REVIEW_ENGINE_AVAILABILITY_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

/** Generates intent groups for a patch with the shared prompt and correction retry. */
export function generateReview(
  request: ReviewEngineRequest,
  options: ClaudeReviewOptions = {},
): Promise<ReviewEngineResult> {
  const run = options.run ?? runClaudeCli;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
  const args = ["-p", "--output-format", "json", "--model", options.model ?? DEFAULT_REVIEW_MODEL];
  return generateReviewWithPrompt(request, async (prompt) =>
    extractClaudeText(await run(args, prompt, timeoutMs)),
  );
}

export { renderPatchForReview };
