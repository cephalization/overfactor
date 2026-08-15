#!/usr/bin/env node
import { daemonBaseUrl, readDaemonInfo } from "@overfactor/sdk/node";
import { claudeHookPayloadSchema, toHookEvent } from "./index.ts";

/**
 * The hook shim Claude Code invokes on every hook event: stdin → zod parse →
 * POST → exit. Runs on every tool call, so cold-start latency is the budget —
 * no CLI framework, no logging setup, and it must NEVER fail the hook:
 * exit code is always 0 and stdout stays empty (Claude Code interprets
 * output/exit codes as hook decisions).
 */

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const info = await readDaemonInfo();
  if (info === null) return; // daemon not running — drop silently

  const payload = claudeHookPayloadSchema.parse(JSON.parse(await readStdin()));
  await fetch(`${daemonBaseUrl(info)}/events`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(toHookEvent(payload)),
    signal: AbortSignal.timeout(1500),
  });
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
