import type { ReviewEngineRequest } from "@overfactor/sdk";
import { describe, expect, it } from "vitest";
import { generateReview, type PiCliRunner, piReviewEngineAvailable } from "../src/review.ts";

const request: ReviewEngineRequest = {
  patch: "diff --git a/src/a.ts b/src/a.ts\n+added",
  intent: {
    crTitle: "Add Pi review generation",
    branch: "feat/pi-review",
    sessionTitles: ["Support reviews through Pi"],
  },
  previousGroups: null,
};

const validResult = {
  groups: [{ name: "Pi review", summary: "Adds the Pi engine.", files: ["src/a.ts"] }],
};

function recordingRunner(outputs: string[]) {
  const calls: Array<{ args: string[]; stdin: string; timeoutMs: number }> = [];
  const run: PiCliRunner = (args, stdin, timeoutMs) => {
    calls.push({ args, stdin, timeoutMs });
    const next = outputs.shift();
    if (next === undefined) throw new Error("no scripted output left");
    return Promise.resolve(next);
  };
  return { run, calls };
}

describe("Pi review generation", () => {
  it("uses isolated print mode and pins provider plus model", async () => {
    const { run, calls } = recordingRunner([JSON.stringify(validResult)]);
    expect(
      await generateReview(request, {
        provider: "openai-codex",
        model: "gpt-5.6-sol",
        run,
      }),
    ).toEqual(validResult);
    expect(calls[0]?.args).toEqual([
      "-p",
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-approve",
      "--provider",
      "openai-codex",
      "--model",
      "gpt-5.6-sol",
    ]);
    expect(calls[0]?.stdin).toContain("GUIDED code review");
  });

  it("shares the correction retry for invalid structured output", async () => {
    const { run, calls } = recordingRunner(["not json", JSON.stringify(validResult)]);
    await expect(
      generateReview(request, { provider: "anthropic", model: "claude-sonnet-5", run }),
    ).resolves.toEqual(validResult);
    expect(calls[1]?.stdin).toContain("Your previous response was rejected");
  });
});

describe("piReviewEngineAvailable", () => {
  it("tracks whether the CLI answers", async () => {
    expect(await piReviewEngineAvailable(() => Promise.resolve("0.82.1"))).toBe(true);
    expect(await piReviewEngineAvailable(() => Promise.reject(new Error("ENOENT")))).toBe(false);
  });
});
