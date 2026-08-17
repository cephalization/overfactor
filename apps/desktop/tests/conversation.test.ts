import { describe, expect, it } from "vitest";
import { buildContinuationPrompt } from "../src/renderer/src/lib/conversation.ts";

describe("buildContinuationPrompt", () => {
  it("keeps dropped files as previews until submission, then serializes their paths", () => {
    expect(
      buildContinuationPrompt("Review these", ["/repo/src/a.ts", "/repo/docs/spec with spaces.md"]),
    ).toBe("Review these\n\nFile paths:\n- /repo/src/a.ts\n- /repo/docs/spec with spaces.md");
  });

  it("supports attachments without additional text", () => {
    expect(buildContinuationPrompt("", ["/repo/image.png"])).toBe("File paths:\n- /repo/image.png");
  });
});
