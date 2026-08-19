import type {
  AgentKind,
  AgentSetupResponse,
  DaemonInfo,
  InstallAgentResponse,
  OnboardingSettings,
} from "@overfactor/sdk";

/** Values validated by preload before crossing into the renderer. */
interface OverfactorBridge {
  getDaemonInfo: () => Promise<DaemonInfo | null>;
  getOnboardingSettings: () => Promise<OnboardingSettings>;
  setOnboardingSettings: (settings: OnboardingSettings) => Promise<OnboardingSettings>;
  agentSetupStatus: () => Promise<AgentSetupResponse>;
  installAgent: (agent: AgentKind) => Promise<InstallAgentResponse>;
  pickDirectory: () => Promise<string | null>;
  getPathForFile: (file: File) => string;
}

declare global {
  interface Window {
    overfactor: OverfactorBridge;
  }
}
