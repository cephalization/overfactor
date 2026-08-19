import type { AgentKind } from "@overfactor/sdk";

export interface AgentSetupOption {
  agent: AgentKind;
  name: string;
  monogram: string;
  description: string;
  benefit: string;
  reload: string;
}

export const AGENT_SETUP_OPTIONS: readonly AgentSetupOption[] = [
  {
    agent: "claude-code",
    name: "Claude Code",
    monogram: "C",
    description:
      "Hooks report session lifecycle, tool activity, and transcript location to Overfactor.",
    benefit: "Also uses your existing Claude login to generate curated reviews.",
    reload: "New Claude sessions pick up the hooks automatically.",
  },
  {
    agent: "pi",
    name: "Pi",
    monogram: "π",
    description:
      "A user-level extension streams session activity and lets Overfactor send prompts back.",
    benefit: "It can also generate curated reviews with your configured Pi models.",
    reload: "Run /reload in open Pi sessions, or restart Pi.",
  },
];
