import { pino } from "pino";

export type Logger = ReturnType<typeof pino>;

/**
 * Root daemon logger. Subsystems take child loggers
 * (`log.child({ subsystem: "watcher" })`). Pretty output only when attached to
 * a TTY and pino-pretty is resolvable (it is a devDependency).
 */
export function createLogger(): Logger {
  const level = process.env.OVERFACTOR_LOG_LEVEL ?? "info";
  if (process.stdout.isTTY) {
    try {
      import.meta.resolve("pino-pretty");
      return pino({ level, transport: { target: "pino-pretty" } });
    } catch {
      // fall through to plain JSON logs
    }
  }
  return pino({ level });
}
