import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readOverfactorConfig, writeOverfactorConfig } from "../src/node.ts";

let previousDir: string | undefined;

beforeEach(async () => {
  previousDir = process.env.OVERFACTOR_DIR;
  process.env.OVERFACTOR_DIR = await mkdtemp(join(tmpdir(), "overfactor-sdk-config-"));
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.OVERFACTOR_DIR;
  else process.env.OVERFACTOR_DIR = previousDir;
});

describe("Overfactor config I/O", () => {
  it("round-trips onboarding state without dropping other settings", async () => {
    const initial = await readOverfactorConfig();
    await writeOverfactorConfig({ ...initial, onboarding: { completed: true } });

    expect(await readOverfactorConfig()).toEqual({
      repos: [],
      review: { agent: "claude-code", provider: null, model: "sonnet" },
      onboarding: { completed: true },
    });
  });
});
