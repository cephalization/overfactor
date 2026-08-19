import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { installPiIntegration, isPiIntegrationInstalled } from "../src/install.ts";

async function tempSettingsPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "overfactor-pi-install-"));
  return join(dir, "agent", "settings.json");
}

describe("installPiIntegration", () => {
  it("resolves its package root when the caller does not provide one", async () => {
    const settingsPath = await tempSettingsPath();
    const result = await installPiIntegration({ settingsPath });

    expect(result.packagePath).toBe(resolve(import.meta.dirname, ".."));
  });

  it("creates settings with the package path when none exist", async () => {
    const settingsPath = await tempSettingsPath();
    const result = await installPiIntegration({ settingsPath, packagePath: "/x/integration-pi" });
    expect(result).toEqual({ settingsPath, packagePath: "/x/integration-pi" });

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.packages).toEqual(["/x/integration-pi"]);
    expect(await isPiIntegrationInstalled({ settingsPath, packagePath: "/x/integration-pi" })).toBe(
      true,
    );
  });

  it("returns false when the settings do not load this package", async () => {
    const settingsPath = await tempSettingsPath();
    expect(await isPiIntegrationInstalled({ settingsPath, packagePath: "/x/integration-pi" })).toBe(
      false,
    );
  });

  it("preserves existing settings and packages, and is idempotent", async () => {
    const settingsPath = await tempSettingsPath();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(settingsPath, ".."), { recursive: true });
    await writeFile(
      settingsPath,
      JSON.stringify({ theme: "dark", packages: ["../../repos/pi-config"] }),
      "utf8",
    );

    await installPiIntegration({ settingsPath, packagePath: "/x/integration-pi" });
    await installPiIntegration({ settingsPath, packagePath: "/x/integration-pi" });

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.packages).toEqual(["../../repos/pi-config", "/x/integration-pi"]);
  });

  it("recognizes an existing relative entry resolving to the same package", async () => {
    const settingsPath = await tempSettingsPath();
    const settingsDir = join(settingsPath, "..");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(settingsDir, { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ packages: ["../pkg"] }), "utf8");

    const packagePath = join(settingsDir, "..", "pkg");
    await installPiIntegration({ settingsPath, packagePath });

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.packages).toEqual(["../pkg"]);
  });
});
