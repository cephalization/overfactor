import type { ReviewEngineRequest } from "@overfactor/sdk";
import { describe, expect, it } from "vitest";
import {
  claudeReviewEngineAvailable,
  type ClaudeCliRunner,
  generateReview,
} from "../src/review.ts";

const request: ReviewEngineRequest = {
  patch: "diff --git a/src/a.ts b/src/a.ts\n+added",
  intent: {
    crTitle: "Rate limit the ingest API",
    branch: "feat/rate-limit",
    sessionTitles: ["Add a token bucket"],
  },
  previousGroups: null,
};

const validResult = {
  groups: [{ name: "Rate limiting", summary: "Adds a token bucket.", files: ["src/a.ts"] }],
};

function printOutput(result: string, isError = false): string {
  return JSON.stringify({ result, is_error: isError, extra: "ignored" });
}

function recordingRunner(outputs: string[]) {
  const calls: string[][] = [];
  const run: ClaudeCliRunner = (args, stdin) => {
    calls.push([...args, stdin]);
    const next = outputs.shift();
    if (next === undefined) throw new Error("no scripted output left");
    return Promise.resolve(next);
  };
  return { run, calls };
}

describe("generateReview", () => {
  it("parses a clean JSON grouping and always pins a model", async () => {
    const { run, calls } = recordingRunner([printOutput(JSON.stringify(validResult))]);
    const result = await generateReview(request, { run });
    expect(result).toEqual(validResult);
    // Never inherit the user's CLI default model — it may be expensive.
    expect(calls[0]?.slice(0, 5)).toEqual(["-p", "--output-format", "json", "--model", "sonnet"]);
  });

  it("puts the intent and diff into the prompt", async () => {
    const { run, calls } = recordingRunner([printOutput(JSON.stringify(validResult))]);
    await generateReview(request, { run });
    const prompt = calls[0]?.at(-1) ?? "";
    expect(prompt).toContain("Branch: feat/rate-limit");
    expect(prompt).toContain("Change request: Rate limit the ingest API");
    expect(prompt).toContain("- Add a token bucket");
    expect(prompt).toContain("<diff>\ndiff --git a/src/a.ts b/src/a.ts");
  });

  it("passes previous groups so regeneration stays stable", async () => {
    const { run, calls } = recordingRunner([printOutput(JSON.stringify(validResult))]);
    await generateReview({ ...request, previousGroups: validResult.groups }, { run });
    expect(calls[0]?.at(-1)).toContain("<previous-groups>");
  });

  it("unwraps code fences and surrounding prose", async () => {
    const { run } = recordingRunner([
      printOutput(`Here you go:\n\`\`\`json\n${JSON.stringify(validResult)}\n\`\`\``),
      printOutput(JSON.stringify(validResult)),
    ]);
    // Prose before a fence defeats the fence regex but not the {...} slice.
    expect(await generateReview(request, { run })).toEqual(validResult);
  });

  it("retries once with the validation error, then succeeds", async () => {
    const { run, calls } = recordingRunner([
      printOutput("not json at all"),
      printOutput(JSON.stringify(validResult)),
    ]);
    expect(await generateReview(request, { run })).toEqual(validResult);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.at(-1)).toContain("Your previous response was rejected");
  });

  it("fails after the retry is also invalid", async () => {
    const { run } = recordingRunner([printOutput("{}"), printOutput("{}")]);
    await expect(generateReview(request, { run })).rejects.toThrow(/failed validation/);
  });

  it("surfaces claude-reported errors", async () => {
    const { run } = recordingRunner([
      printOutput("usage limit reached", true),
      printOutput("usage limit reached", true),
    ]);
    await expect(generateReview(request, { run })).rejects.toThrow(/usage limit reached/);
  });

  it("adds --model when a model is pinned", async () => {
    const { run, calls } = recordingRunner([printOutput(JSON.stringify(validResult))]);
    await generateReview(request, { run, model: "claude-haiku-4-5" });
    expect(calls[0]).toContain("--model");
    expect(calls[0]).toContain("claude-haiku-4-5");
  });
});

describe("claudeReviewEngineAvailable", () => {
  it("is true when --version answers and false when the CLI is missing", async () => {
    expect(await claudeReviewEngineAvailable(() => Promise.resolve("1.0.0"))).toBe(true);
    expect(await claudeReviewEngineAvailable(() => Promise.reject(new Error("ENOENT")))).toBe(
      false,
    );
  });
});
