import { join } from "node:path";
import {
  installClaudeCodeIntegration,
  isClaudeCodeIntegrationInstalled,
} from "@overfactor/integration-claude-code/install";
import { installPiIntegration, isPiIntegrationInstalled } from "@overfactor/integration-pi/install";
import {
  type AgentKind,
  agentKindSchema,
  type OnboardingSettings,
  onboardingSettingsSchema,
} from "@overfactor/sdk";
import { readDaemonInfo, readOverfactorConfig, writeOverfactorConfig } from "@overfactor/sdk/node";
import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";

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

  // In-app links (PR URLs) open in the system browser, never a new
  // Electron window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
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

  // Onboarding state is app-shell state, so it stays available even when the
  // daemon is down. Writes still use the shared validated Overfactor config.
  ipcMain.handle("overfactor:onboarding-settings", async () =>
    onboardingSettingsSchema.parse((await readOverfactorConfig()).onboarding),
  );
  ipcMain.handle(
    "overfactor:set-onboarding-settings",
    async (_event, rawSettings: OnboardingSettings) => {
      const onboarding = onboardingSettingsSchema.parse(rawSettings);
      const config = await readOverfactorConfig();
      await writeOverfactorConfig({ ...config, onboarding });
      return onboarding;
    },
  );

  // Agent settings are deliberately managed through privileged Electron IPC,
  // not the daemon's unauthenticated loopback API: installing a hook/extension
  // writes user-level config outside ~/.overfactor.
  ipcMain.handle("overfactor:agent-setup-status", async () => {
    const [claudeInstalled, piInstalled] = await Promise.all([
      isClaudeCodeIntegrationInstalled(),
      isPiIntegrationInstalled(),
    ]);
    return {
      integrations: [
        { agent: "claude-code" as const, installed: claudeInstalled },
        { agent: "pi" as const, installed: piInstalled },
      ],
    };
  });
  ipcMain.handle("overfactor:install-agent", async (_event, rawAgent: AgentKind) => {
    const agent = agentKindSchema.parse(rawAgent);
    if (agent === "claude-code") await installClaudeCodeIntegration();
    else await installPiIntegration();
    return { agent, installed: true as const };
  });

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
