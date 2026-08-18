import { describe, expect, it } from "vitest";
import { collapseReason } from "../src/renderer/src/lib/diff-noise.ts";

describe("collapseReason", () => {
  it("collapses lockfiles anywhere in the tree, case-insensitively", () => {
    expect(collapseReason("pnpm-lock.yaml", 5)).toBe("lockfile");
    expect(collapseReason("apps/desktop/package-lock.json", 5)).toBe("lockfile");
    expect(collapseReason("Gemfile.lock", 5)).toBe("lockfile");
    expect(collapseReason("go.sum", 5)).toBe("lockfile");
  });

  it("collapses generated output by directory and extension", () => {
    expect(collapseReason("dist/index.mjs", 5)).toBe("generated");
    expect(collapseReason("packages/sdk/__snapshots__/x.snap", 5)).toBe("generated");
    expect(collapseReason("assets/app.min.js", 5)).toBe("generated");
    expect(collapseReason("web/bundle.js.map", 5)).toBe("generated");
    expect(collapseReason("api/service.pb.go", 5)).toBe("generated");
    expect(collapseReason("proto/service_pb2.py", 5)).toBe("generated");
    expect(collapseReason("models/schema.generated.ts", 5)).toBe("generated");
  });

  it("collapses very large diffs and leaves ordinary files expanded", () => {
    expect(collapseReason("src/review.ts", 301)).toBe("large diff");
    expect(collapseReason("src/review.ts", 300)).toBeNull();
    expect(collapseReason("src/limiter.ts", 12)).toBeNull();
  });

  it("does not misfire on handwritten files with lookalike names", () => {
    expect(collapseReason("src/lockfile-parser.ts", 10)).toBeNull();
    expect(collapseReason("docs/distribution.md", 10)).toBeNull();
    expect(collapseReason("src/output.ts", 10)).toBeNull();
    expect(collapseReason("src/snapshot.ts", 10)).toBeNull();
  });
});
