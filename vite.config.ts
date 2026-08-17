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
      ".agent/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".continue/**",
      ".cursor/**",
      ".gemini/**",
      ".opencode/**",
      ".pi/**",
      ".roo/**",
      ".windsurf/**",
      "packages/just-git/**",
      "tools/oxlint/anti-slop/**",
      "**/out/**",
      "**/components/ui/**",
      "**/hooks/use-mobile.ts",
    ],
    jsPlugins: [{ name: "anti-slop", specifier: "./tools/oxlint/anti-slop/index.ts" }],
    options: { typeAware: true, typeCheck: true },
    rules: {
      "anti-slop/no-chained-type-assertions": "error",
      "anti-slop/no-conditional-empty-object-spread": "error",
      "anti-slop/no-known-value-widening": "error",
      "anti-slop/no-module-mocking": "error",
      "anti-slop/no-object-parameters": "error",
      "anti-slop/no-reflect-apply": "error",
      "anti-slop/no-reflect-get": "error",
      "anti-slop/no-runtime-typeof": "error",
      "anti-slop/no-shape-in-symbol-names": "error",
      "anti-slop/no-unknown-parameters": "error",
      "anti-slop/no-unknown-returns": "error",
      "anti-slop/no-unknown-type-aliases": "error",
      "anti-slop/no-unsafe-dictionary-type": "error",
      "anti-slop/no-widen-then-assert": "error",
      "anti-slop/require-safety-comment-for-type-assertion": "error",
    },
  },
  fmt: {
    // design.html is a generated self-extracting bundle; reformatting it
    // could corrupt the packed payload.
    ignorePatterns: [
      ".agent/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".continue/**",
      ".cursor/**",
      ".gemini/**",
      ".opencode/**",
      ".pi/**",
      ".roo/**",
      ".windsurf/**",
      "packages/just-git/**",
      "tools/oxlint/anti-slop/**",
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
