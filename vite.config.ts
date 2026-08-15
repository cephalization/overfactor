import { defineConfig } from "vite-plus";

// packages/just-git is a vendored submodule with its own toolchain (oxlint
// config, bun-only tests, plain tsc build) — excluded from workspace-wide
// test/check sweeps. See FINDINGS.md.
export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  lint: {
    // components/ui and use-mobile are shadcn CLI output: consumed as
    // generated code, never hand-edited (see FINDINGS.md).
    ignorePatterns: [
      "packages/just-git/**",
      "**/out/**",
      "**/components/ui/**",
      "**/hooks/use-mobile.ts",
    ],
    options: { typeAware: true, typeCheck: true },
  },
  fmt: {
    // design.html is a generated self-extracting bundle; reformatting it
    // could corrupt the packed payload.
    ignorePatterns: [
      "packages/just-git/**",
      "design.html",
      "**/out/**",
      "**/components/ui/**",
      "**/hooks/use-mobile.ts",
    ],
  },
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "packages/just-git/**"],
  },
});
