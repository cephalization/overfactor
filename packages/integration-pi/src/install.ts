import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

/**
 * Installs this package into Pi's user settings (`~/.pi/agent/settings.json`
 * — Pi's default install target), so every Pi session on the machine loads
 * the integration regardless of which repo it runs in. Idempotent: an entry
 * already resolving to this package is left alone, and everything else in
 * the settings file is preserved.
 */

const piSettingsSchema = z.looseObject({
  packages: z.array(z.string()).optional(),
});

export interface InstallPiResult {
  settingsPath: string;
  packagePath: string;
}

export interface InstallPiOptions {
  /** Defaults to `~/.pi/agent/settings.json`. */
  settingsPath?: string;
  /** Defaults to this package's own root directory. */
  packagePath?: string;
}

function defaultPackagePath(): string {
  // Resolve the package by name instead of walking from this module URL.
  // Desktop bundlers may inline this installer into their own output, where
  // import.meta.url belongs to the app bundle rather than this package.
  return dirname(fileURLToPath(import.meta.resolve("@overfactor/integration-pi/package.json")));
}

/** Pi resolves relative package paths against the settings file's directory. */
function resolvesToPackage(entry: string, settingsDir: string, packagePath: string): boolean {
  return resolve(settingsDir, entry) === packagePath;
}

/** Checks whether Pi's user settings load this integration package. */
export async function isPiIntegrationInstalled(options?: InstallPiOptions): Promise<boolean> {
  const settingsPath = options?.settingsPath ?? join(homedir(), ".pi", "agent", "settings.json");
  const packagePath = resolve(options?.packagePath ?? defaultPackagePath());
  try {
    const settings = piSettingsSchema.parse(JSON.parse(await readFile(settingsPath, "utf8")));
    const settingsDir = dirname(settingsPath);
    return (settings.packages ?? []).some((entry) =>
      resolvesToPackage(entry, settingsDir, packagePath),
    );
  } catch {
    return false;
  }
}

export async function installPiIntegration(options?: InstallPiOptions): Promise<InstallPiResult> {
  const settingsPath = options?.settingsPath ?? join(homedir(), ".pi", "agent", "settings.json");
  const packagePath = resolve(options?.packagePath ?? defaultPackagePath());

  const raw = await readFile(settingsPath, "utf8").catch(() => "{}");
  const settings = piSettingsSchema.parse(JSON.parse(raw));
  const packages = settings.packages ?? [];

  const settingsDir = dirname(settingsPath);
  if (!packages.some((entry) => resolvesToPackage(entry, settingsDir, packagePath))) {
    packages.push(packagePath);
  }

  const next = { ...settings, packages };
  await mkdir(settingsDir, { recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { settingsPath, packagePath };
}
