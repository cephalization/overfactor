import { contextBridge, ipcRenderer } from "electron";

// Values crossing this bridge are untyped in the renderer; the renderer
// validates them with SDK schemas before use.
contextBridge.exposeInMainWorld("overfactor", {
  getDaemonInfo: (): Promise<unknown> => ipcRenderer.invoke("overfactor:daemon-info"),
  pickDirectory: (): Promise<unknown> => ipcRenderer.invoke("overfactor:pick-directory"),
});
