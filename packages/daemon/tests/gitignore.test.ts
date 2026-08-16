import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitIgnoreMatcher } from "../src/gitignore.ts";

async function tempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "overfactor-gitignore-"));
}

describe("GitIgnoreMatcher", () => {
  it("applies root ignore rules and built-in exclusions", async () => {
    const repo = await tempRepo();
    await writeFile(join(repo, ".gitignore"), "dist/\n*.log\n!important.log\n", "utf8");
    const matcher = new GitIgnoreMatcher(repo);

    await expect(matcher.ignores("dist/app.js")).resolves.toBe(true);
    await expect(matcher.ignores("src/debug.log")).resolves.toBe(true);
    await expect(matcher.ignores("important.log")).resolves.toBe(false);
    await expect(matcher.ignores("src/app.ts")).resolves.toBe(false);
    await expect(matcher.ignores("node_modules/pkg/index.js")).resolves.toBe(true);
    await expect(matcher.ignores(".git/index")).resolves.toBe(true);
  });

  it("applies nested .gitignore rules after parent rules", async () => {
    const repo = await tempRepo();
    const nested = join(repo, "packages", "app");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(nested, { recursive: true });
    await writeFile(join(repo, ".gitignore"), "*.log\n", "utf8");
    await writeFile(join(nested, ".gitignore"), "!keep.log\ncache/\n", "utf8");
    const matcher = new GitIgnoreMatcher(repo);

    await expect(matcher.ignores("packages/app/debug.log")).resolves.toBe(true);
    await expect(matcher.ignores("packages/app/keep.log")).resolves.toBe(false);
    await expect(matcher.ignores("packages/app/cache/result.json")).resolves.toBe(true);
  });

  it("does not let a nested file re-include content below an ignored parent", async () => {
    const repo = await tempRepo();
    const vendor = join(repo, "vendor");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(vendor, { recursive: true });
    await writeFile(join(repo, ".gitignore"), "vendor/\n", "utf8");
    await writeFile(join(vendor, ".gitignore"), "!keep.js\n", "utf8");
    const matcher = new GitIgnoreMatcher(repo);

    await expect(matcher.ignores("vendor/keep.js")).resolves.toBe(true);
  });

  it("reloads rules after invalidation and never ignores .gitignore events", async () => {
    const repo = await tempRepo();
    const ignorePath = join(repo, ".gitignore");
    await writeFile(ignorePath, "first.txt\n", "utf8");
    const matcher = new GitIgnoreMatcher(repo);

    await expect(matcher.ignores("first.txt")).resolves.toBe(true);
    await writeFile(ignorePath, "second.txt\n", "utf8");
    await expect(matcher.ignores("second.txt")).resolves.toBe(false);

    matcher.invalidate();
    await expect(matcher.ignores("second.txt")).resolves.toBe(true);
    await expect(matcher.ignores(".gitignore")).resolves.toBe(false);
  });
});
