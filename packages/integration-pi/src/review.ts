import type { ReviewEngineRequest, ReviewEngineResult, ReviewModelOption } from "@overfactor/sdk";
import {
  DEFAULT_REVIEW_TIMEOUT_MS,
  generateReviewWithPrompt,
  REVIEW_ENGINE_AVAILABILITY_TIMEOUT_MS,
  runCli,
} from "@overfactor/integration-utils";

/** Runs the pi CLI; injectable so tests never spawn a real agent. */
export type PiCliRunner = (args: string[], stdin: string, timeoutMs: number) => Promise<string>;

const runPiCli: PiCliRunner = (args, stdin, timeoutMs) =>
  runCli({
    command: "pi",
    args,
    stdin,
    timeoutMs,
    // Avoid update checks on every generated review. Provider requests still
    // run normally; PI_OFFLINE would be too broad here.
    env: { ...process.env, PI_SKIP_VERSION_CHECK: "1" },
  });

export interface PiReviewOptions {
  provider: string;
  model: string;
  timeoutMs?: number;
  run?: PiCliRunner;
}

/** True when the `pi` CLI is installed and answers on this machine. */
export async function piReviewEngineAvailable(run: PiCliRunner = runPiCli): Promise<boolean> {
  try {
    await run(["--version"], "", REVIEW_ENGINE_AVAILABILITY_TIMEOUT_MS);
    return true;
  } catch {
    return false;
  }
}

/**
 * Models Pi can currently authenticate to, including custom providers from
 * models.json. This uses Pi's model runtime rather than parsing human-oriented
 * CLI table output.
 */
export async function listPiReviewModels(): Promise<ReviewModelOption[]> {
  // Keep the large Pi SDK off the daemon's startup path; only Settings needs it.
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const runtime = await ModelRuntime.create();
  return (await runtime.getAvailable())
    .map((model) => ({ provider: model.provider, model: model.id, name: model.name }))
    .sort((left, right) =>
      `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`),
    );
}

/** Generates a walkthrough through Pi's isolated, tool-free print mode. */
export function generateReview(
  request: ReviewEngineRequest,
  options: PiReviewOptions,
): Promise<ReviewEngineResult> {
  const run = options.run ?? runPiCli;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
  const args = [
    "-p",
    "--no-session",
    "--no-tools",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-approve",
    "--provider",
    options.provider,
    "--model",
    options.model,
  ];
  return generateReviewWithPrompt(request, (prompt) => run(args, prompt, timeoutMs));
}
