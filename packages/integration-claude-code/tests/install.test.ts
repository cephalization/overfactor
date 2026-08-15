import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installClaudeCodeIntegration } from "../src/install.ts";

async function tempSettingsPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "overfactor-install-"));
  return join(dir, "settings.json");
}

describe("installClaudeCodeIntegration", () => {
  it("writes hooks for every lifecycle event into fresh settings", async () => {
    const settingsPath = await tempSettingsPath();
    const result = await installClaudeCodeIntegration({
      settingsPath,
      hookCommand: "node /x/overfactor-claude-hook.mjs",
    });
    expect(result.settingsPath).toBe(settingsPath);

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "Notification",
      "Stop",
      "SessionEnd",
    ]) {
      expect(settings.hooks[event]).toHaveLength(1);
      expect(settings.hooks[event][0].hooks[0].command).toContain("overfactor-claude-hook");
    }
    expect(settings.hooks.PreToolUse[0].matcher).toBe("*");
    expect(settings.hooks.SessionStart[0].matcher).toBeUndefined();
  });

  it("is idempotent and preserves foreign hooks and settings", async () => {
    const settingsPath = await tempSettingsPath();
    const existing = {
      model: "opus",
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }],
      },
    };
    const { writeFile } = await import("node:fs/promises");
    await writeFile(settingsPath, JSON.stringify(existing), "utf8");

    const hookCommand = "node /x/overfactor-claude-hook.mjs";
    await installClaudeCodeIntegration({ settingsPath, hookCommand });
    await installClaudeCodeIntegration({ settingsPath, hookCommand });

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.model).toBe("opus");
    expect(settings.hooks.PreToolUse).toHaveLength(2);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe("my-linter");
    expect(settings.hooks.Stop).toHaveLength(1);
  });
});
