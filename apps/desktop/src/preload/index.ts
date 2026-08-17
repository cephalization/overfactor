import { type DaemonInfo, daemonInfoSchema } from "@overfactor/sdk";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { z } from "zod";

const pickedDirectorySchema = z.string().min(1).nullable();

// Validate IPC results in preload before exposing a typed bridge. Renderer
// call sites retain their schema checks as defense in depth.
contextBridge.exposeInMainWorld("overfactor", {
  getDaemonInfo: async (): Promise<DaemonInfo | null> => {
    const parsed = daemonInfoSchema
      .nullable()
      .safeParse(await ipcRenderer.invoke("overfactor:daemon-info"));
    return parsed.success ? parsed.data : null;
  },
  pickDirectory: async (): Promise<string | null> =>
    pickedDirectorySchema.parse(await ipcRenderer.invoke("overfactor:pick-directory")),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
});
