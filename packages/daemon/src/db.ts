import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  agent: text("agent").notNull(),
  title: text("title"),
  /** How the title was set: manual > native (agent-generated) > prompt. */
  titleSource: text("title_source"),
  state: text("state").notNull(),
  cwd: text("cwd").notNull(),
  repoPath: text("repo_path").notNull(),
  transcriptPath: text("transcript_path"),
  /** Branch checked out in the session's worktree; null when detached/unknown. */
  branch: text("branch"),
  /** Manual pin to a Change Request; overrides automatic branch grouping. */
  crId: integer("cr_id"),
  archived: integer("archived", { mode: "boolean" }).notNull().default(false),
  filesChanged: integer("files_changed"),
  insertions: integer("insertions"),
  deletions: integer("deletions"),
  startedAt: text("started_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type SessionRow = typeof sessions.$inferSelect;

export const changeRequests = sqliteTable("change_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  repoPath: text("repo_path").notNull(),
  branch: text("branch").notNull(),
  title: text("title").notNull(),
  prNumber: integer("pr_number"),
  prState: text("pr_state"),
  prUrl: text("pr_url"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type ChangeRequestRow = typeof changeRequests.$inferSelect;

// Kept in lockstep with the drizzle tables above; a drizzle-kit migration
// pipeline replaces this once the schema outgrows hand-managed DDL.
const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  title TEXT,
  title_source TEXT,
  state TEXT NOT NULL,
  cwd TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  transcript_path TEXT,
  branch TEXT,
  cr_id INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  files_changed INTEGER,
  insertions INTEGER,
  deletions INTEGER,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS change_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  title TEXT NOT NULL,
  pr_number INTEGER,
  pr_state TEXT,
  pr_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS change_requests_repo_branch
  ON change_requests (repo_path, branch);
`;

/** Columns added after the sessions table first shipped; applied to old dbs. */
const SESSION_COLUMN_MIGRATIONS: Record<string, string> = {
  title_source: "ALTER TABLE sessions ADD COLUMN title_source TEXT",
  branch: "ALTER TABLE sessions ADD COLUMN branch TEXT",
  cr_id: "ALTER TABLE sessions ADD COLUMN cr_id INTEGER",
  archived: "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
};

export type Db = ReturnType<typeof openDb>;

/** Opens (creating if needed) the daemon database. Use ":memory:" in tests. */
export function openDb(path: string) {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.exec(DDL);
  const existing = new Set(
    (sqlite.pragma("table_info(sessions)") as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [column, statement] of Object.entries(SESSION_COLUMN_MIGRATIONS)) {
    if (!existing.has(column)) sqlite.exec(statement);
  }
  return drizzle(sqlite, { schema: { sessions, changeRequests } });
}
