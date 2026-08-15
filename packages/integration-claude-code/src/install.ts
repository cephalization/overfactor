import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Installs the Overfactor hook shim into Claude Code's user settings
 * (`~/.claude/settings.json`), the mechanism Claude Code prescribes for
 * hooks. Idempotent: re-running replaces previous Overfactor entries and
 * preserves everything else in the file.
 */

const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  "SessionEnd",
] as const;

/**
 * Markers matched to recognize (and replace) our own entries on reinstall:
 * the published bin name and the package dir a direct `node dist/hook.mjs`
 * command path always contains.
 */
const HOOK_MARKERS = ["overfactor-claude-hook", "integration-claude-code"];

const hookCommandSchema = z.looseObject({
  type: z.string(),
  command: z.string().optional(),
});

const hookEntrySchema = z.looseObject({
  matcher: z.string().optional(),
  hooks: z.array(hookCommandSchema),
});

const settingsSchema = z.looseObject({
  hooks: z.record(z.string(), z.array(hookEntrySchema)).optional(),
});

export interface InstallResult {
  settingsPath: string;
  hookCommand: string;
}

export interface InstallOptions {
  /** Defaults to `~/.claude/settings.json`. */
  settingsPath?: string;
  /** Defaults to `node <built hook shim next to this module>`. */
  hookCommand?: string;
}

function defaultHookCommand(): string {
  const shimPath = fileURLToPath(new URL("./hook.mjs", import.meta.url));
  return `${process.execPath} ${shimPath}`;
}

export async function installClaudeCodeIntegration(
  options?: InstallOptions,
): Promise<InstallResult> {
  const settingsPath = options?.settingsPath ?? join(homedir(), ".claude", "settings.json");
  const hookCommand = options?.hookCommand ?? defaultHookCommand();

  const raw = await readFile(settingsPath, "utf8").catch(() => "{}");
  const settings = settingsSchema.parse(JSON.parse(raw));
  const hooks = settings.hooks ?? {};

  for (const event of HOOK_EVENTS) {
    const entries = (hooks[event] ?? []).filter(
      (entry) =>
        !entry.hooks.some((hook) =>
          HOOK_MARKERS.some((marker) => hook.command?.includes(marker) ?? false),
        ),
    );
    entries.push({
      ...(event === "PreToolUse" || event === "PostToolUse" ? { matcher: "*" } : {}),
      hooks: [{ type: "command", command: hookCommand }],
    });
    hooks[event] = entries;
  }

  const next = { ...settings, hooks };
  await mkdir(dirname(settingsPath), { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { settingsPath, hookCommand };
}
