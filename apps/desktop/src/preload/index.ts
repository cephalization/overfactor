import { type DaemonInfo, daemonInfoSchema } from "@overfactor/sdk";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { z } from "zod";

// The preload evaluates before the page's CSP meta tag applies, so zod's
// eval-availability probe (run at schema construction) sees codegen as
// allowed — but its lazy per-schema "fastpass" compiles at first parse,
// which happens after the CSP is active and throws an EvalError that
// escapes safeParse. The global config covers schemas constructed in this
// module; SDK schemas are constructed during import, before this line runs,
// so every parse of an SDK schema below must also pass `{ jitless: true }`.
z.config({ jitless: true });

const pickedDirectorySchema = z.string().min(1).nullable();

// Validate IPC results in preload before exposing a typed bridge. Renderer
// call sites retain their schema checks as defense in depth.
contextBridge.exposeInMainWorld("overfactor", {
  getDaemonInfo: async (): Promise<DaemonInfo | null> => {
    const parsed = daemonInfoSchema
      .nullable()
      .safeParse(await ipcRenderer.invoke("overfactor:daemon-info"), { jitless: true });
    return parsed.success ? parsed.data : null;
  },
  pickDirectory: async (): Promise<string | null> =>
    pickedDirectorySchema.parse(await ipcRenderer.invoke("overfactor:pick-directory")),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
});
