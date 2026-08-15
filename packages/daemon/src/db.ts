import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  agent: text("agent").notNull(),
  title: text("title"),
  state: text("state").notNull(),
  cwd: text("cwd").notNull(),
  repoPath: text("repo_path").notNull(),
  transcriptPath: text("transcript_path"),
  filesChanged: integer("files_changed"),
  insertions: integer("insertions"),
  deletions: integer("deletions"),
  startedAt: text("started_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type SessionRow = typeof sessions.$inferSelect;

// Kept in lockstep with the drizzle table above; a drizzle-kit migration
// pipeline replaces this once the schema outgrows a single table.
const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  title TEXT,
  state TEXT NOT NULL,
  cwd TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  transcript_path TEXT,
  files_changed INTEGER,
  insertions INTEGER,
  deletions INTEGER,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export type Db = ReturnType<typeof openDb>;

/** Opens (creating if needed) the daemon database. Use ":memory:" in tests. */
export function openDb(path: string) {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(DDL);
  return drizzle(sqlite, { schema: { sessions } });
}
