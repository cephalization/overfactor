import type { ReviewSettings } from "@overfactor/sdk";
import { reviewSettingsSchema } from "@overfactor/sdk";
import { readOverfactorConfig, writeOverfactorConfig } from "@overfactor/sdk/node";

/** Persists the default review engine/provider/model policy. */
export async function updateReviewSettings(settings: ReviewSettings): Promise<ReviewSettings> {
  const review = reviewSettingsSchema.parse(settings);
  const config = await readOverfactorConfig();
  await writeOverfactorConfig({ ...config, review });
  return review;
}
