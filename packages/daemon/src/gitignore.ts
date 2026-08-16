import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";
import ignore from "ignore";

type IgnoreMatcher = ReturnType<typeof ignore>;

interface ScopedMatcher {
  /** Directory containing the .gitignore, relative to the repo root. */
  scope: string;
  matcher: IgnoreMatcher;
}

function normalizeRelativePath(path: string): string | null {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (
    normalized === "" ||
    normalized === "." ||
    posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return null;
  }
  return normalized;
}

/**
 * Unconditional `.git`/`node_modules` exclusion, tolerant of either path
 * separator. Watcher callbacks run this before anything else — including
 * cache invalidation — so events from those subtrees cost nothing.
 */
export function isBuiltInIgnoredPath(path: string): boolean {
  return /(^|\/)(\.git|node_modules)(\/|$)/.test(path.replaceAll("\\", "/"));
}

function applyMatchers(matchers: ScopedMatcher[], target: string): boolean {
  let ignored = false;
  for (const { scope, matcher } of matchers) {
    const relative = scope === "" ? target : target.slice(scope.length + 1);
    const result = matcher.test(relative);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

/**
 * Lazily loads the .gitignore chain relevant to each watcher event. This
 * honors nested files without crawling the repository at daemon startup.
 */
export class GitIgnoreMatcher {
  private readonly cache = new Map<string, Promise<IgnoreMatcher | null>>();

  constructor(private readonly repo: string) {}

  invalidate(): void {
    this.cache.clear();
  }

  async ignores(relativePath: string): Promise<boolean> {
    const target = normalizeRelativePath(relativePath);
    if (target === null || isBuiltInIgnoredPath(target)) return true;

    // Changes to ignore files must always invalidate the cache and reach the
    // diff scheduler; a tracked .gitignore can itself appear in git diff.
    if (posix.basename(target) === ".gitignore") return false;

    const matchers: ScopedMatcher[] = [];
    const rootMatcher = await this.load("");
    if (rootMatcher !== null) matchers.push({ scope: "", matcher: rootMatcher });

    const parent = posix.dirname(target);
    if (parent !== ".") {
      let scope = "";
      for (const segment of parent.split("/")) {
        scope = scope === "" ? segment : `${scope}/${segment}`;

        // Git never reads a nested .gitignore when an ancestor directory is
        // excluded, so rules below that directory cannot re-include a file.
        if (applyMatchers(matchers, `${scope}/`)) return true;

        const matcher = await this.load(scope);
        if (matcher !== null) matchers.push({ scope, matcher });
      }
    }

    return applyMatchers(matchers, target);
  }

  private load(scope: string): Promise<IgnoreMatcher | null> {
    const cached = this.cache.get(scope);
    if (cached !== undefined) return cached;

    const path = join(this.repo, scope, ".gitignore");
    const loaded = readFile(path, "utf8")
      .then((patterns) => ignore().add(patterns))
      .catch(() => null);
    this.cache.set(scope, loaded);
    return loaded;
  }
}
