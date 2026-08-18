/**
 * Low-signal-file detection for the guided review: files a reviewer should
 * skim as a collapsed bar, not read line by line. Path heuristics only —
 * cheap, predictable, and wrong in ways an expand click fixes.
 */

export type CollapseReason = "lockfile" | "generated" | "large diff";

const LOCKFILE_NAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "deno.lock",
  "flake.lock",
  "gemfile.lock",
  "go.sum",
  "gradle.lockfile",
  "package-lock.json",
  "packages.lock.json",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "podfile.lock",
  "poetry.lock",
  "uv.lock",
  "yarn.lock",
]);

const GENERATED_DIRS = /(^|\/)(dist|build|out|coverage|__generated__|__snapshots__|vendor)\//;
const GENERATED_FILES =
  /\.(min\.(js|css)|(js|css)\.map|snap|generated\.[^./]+|pb\.(go|cc|h|swift)|g\.(ts|cs|dart))$|_pb2?\.pyi?$/;

/** Changed-line count above which a file is skimmed collapsed by default. */
const LARGE_CHANGE_LINES = 300;

/** Why `path` should render collapsed, or null to show its diff in full. */
export function collapseReason(path: string, changedLines: number): CollapseReason | null {
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  if (LOCKFILE_NAMES.has(base)) return "lockfile";
  if (GENERATED_DIRS.test(lower) || GENERATED_FILES.test(lower)) return "generated";
  if (changedLines > LARGE_CHANGE_LINES) return "large diff";
  return null;
}
