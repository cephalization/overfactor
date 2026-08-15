/**
 * The preload bridge. Everything arriving over it is `unknown` on purpose —
 * validate with SDK schemas at the call site.
 */
interface OverfactorBridge {
  getDaemonInfo: () => Promise<unknown>;
  pickDirectory: () => Promise<unknown>;
}

interface Window {
  overfactor: OverfactorBridge;
}
