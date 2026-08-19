import { mkdir, writeFile } from "node:fs/promises";
import type { OverfactorConfig, ReviewSettings } from "@overfactor/sdk";
import { reviewSettingsSchema } from "@overfactor/sdk";
import { configPath, overfactorDir, readOverfactorConfig } from "@overfactor/sdk/node";

/** Single durable writer for `~/.overfactor/config.json`. */
export async function writeOverfactorConfig(config: OverfactorConfig): Promise<void> {
  await mkdir(overfactorDir(), { recursive: true });
  await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** Persists the default review engine/provider/model policy. */
export async function updateReviewSettings(settings: ReviewSettings): Promise<ReviewSettings> {
  const review = reviewSettingsSchema.parse(settings);
  const config = await readOverfactorConfig();
  await writeOverfactorConfig({ ...config, review });
  return review;
}
