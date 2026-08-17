import type { DaemonInfo } from "@overfactor/sdk";

/** Values validated by preload before crossing into the renderer. */
interface OverfactorBridge {
  getDaemonInfo: () => Promise<DaemonInfo | null>;
  pickDirectory: () => Promise<string | null>;
  getPathForFile: (file: File) => string;
}

declare global {
  interface Window {
    overfactor: OverfactorBridge;
  }
}
