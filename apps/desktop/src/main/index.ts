import { join } from "node:path";
import { readDaemonInfo } from "@overfactor/sdk/node";
import { app, BrowserWindow, dialog, ipcMain } from "electron";

// Agent/CI hook: expose the Chrome DevTools Protocol so tools like
// agent-browser can drive the app (see TESTING.md). Must be set before ready.
if (process.env.OVERFACTOR_CDP_PORT !== undefined) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.OVERFACTOR_CDP_PORT);
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    title: "Overfactor",
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      // ESM preload scripts require an unsandboxed renderer; context
      // isolation (the actual security boundary here) stays on.
      sandbox: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL !== undefined) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
}

void app.whenReady().then(() => {
  // Renderer discovers the daemon through this: main reads and validates
  // ~/.overfactor/daemon.json (the renderer has no fs access).
  ipcMain.handle("overfactor:daemon-info", () => readDaemonInfo());

  // Native directory picker for tracking a repo; returns the chosen absolute
  // path or null on cancel. Tracking itself goes through the daemon's API.
  ipcMain.handle("overfactor:pick-directory", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (window === null) return null;
    const result = await dialog.showOpenDialog(window, {
      title: "Track a repo",
      properties: ["openDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
