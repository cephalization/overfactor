import type { ReviewEngineRequest } from "@overfactor/sdk";
import { describe, expect, it } from "vitest";
import {
  buildReviewPrompt,
  extractReviewResult,
  generateReviewWithPrompt,
  renderPatchForReview,
} from "../src/index.ts";

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

describe("shared review prompt", () => {
  it("includes intent, every-file manifest, and the diff", () => {
    const prompt = buildReviewPrompt(request, null);
    expect(prompt).toContain("Branch: feat/rate-limit");
    expect(prompt).toContain("Change request: Rate limit the ingest API");
    expect(prompt).toContain("M +1 -0 src/a.ts");
    expect(prompt).toContain("<diff>\ndiff --git a/src/a.ts b/src/a.ts");
  });

  it("extracts JSON through fences or surrounding prose", () => {
    expect(
      extractReviewResult(`Here:\n\`\`\`json\n${JSON.stringify(validResult)}\n\`\`\``),
    ).toEqual(validResult);
  });

  it("retries once with the validation reason", async () => {
    const prompts: string[] = [];
    const outputs = ["invalid", JSON.stringify(validResult)];
    const result = await generateReviewWithPrompt(request, (prompt) => {
      prompts.push(prompt);
      return Promise.resolve(outputs.shift() ?? "");
    });
    expect(result).toEqual(validResult);
    expect(prompts[1]).toContain("Your previous response was rejected");
  });
});

describe("renderPatchForReview", () => {
  const fileChunk = (path: string, body: string, status = "") =>
    `diff --git a/${path} b/${path}\n${status}${body}\n`;

  it("lists every file and collapses deleted or generated bodies", () => {
    const patch =
      fileChunk("src/a.ts", "+one\n+two") +
      fileChunk("src/b.ts", "-old", "deleted file mode 100644\n") +
      fileChunk("src/__generated__/c.ts", "+generated");
    const rendered = renderPatchForReview(patch);
    expect(rendered.manifest).toBe(
      "M +2 -0 src/a.ts\nD +0 -1 src/b.ts\nM +1 -0 src/__generated__/c.ts",
    );
    expect(rendered.diff).toContain("body omitted: deleted file");
    expect(rendered.diff).toContain("body omitted: generated/lockfile content");
    expect(rendered.omittedCount).toBe(2);
  });

  it("stubs oversized files without cutting their bodies mid-file", () => {
    const patch =
      fileChunk("src/small.ts", "+small") + fileChunk("src/huge.ts", `+${"x".repeat(200_000)}`);
    const rendered = renderPatchForReview(patch);
    expect(rendered.diff).toContain("+small");
    expect(rendered.diff).toContain("body omitted for length");
    expect(rendered.diff).not.toContain("x".repeat(100));
    expect(rendered.manifest).toContain("src/huge.ts");
  });
});
