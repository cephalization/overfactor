import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installPiIntegration } from "../src/install.ts";

async function tempSettingsPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "overfactor-pi-install-"));
  return join(dir, "agent", "settings.json");
}

describe("installPiIntegration", () => {
  it("creates settings with the package path when none exist", async () => {
    const settingsPath = await tempSettingsPath();
    const result = await installPiIntegration({ settingsPath, packagePath: "/x/integration-pi" });
    expect(result).toEqual({ settingsPath, packagePath: "/x/integration-pi" });

    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(settings.packages).toEqual(["/x/integration-pi"]);
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
