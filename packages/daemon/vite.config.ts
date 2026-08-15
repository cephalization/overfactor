import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/index.ts", "src/client.ts", "src/cli.ts"],
    dts: {
      tsgo: true,
    },
    // exports/bin are hand-maintained: tsdown's generator renames our bin
    // ("overfactor") after the package directory.
    exports: false,
  },
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  fmt: {},
});
