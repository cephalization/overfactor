import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  agent: text("agent").notNull(),
  model: text("model"),
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

export const reviews = sqliteTable("reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  /** Reviews are branch-level: one per (repoPath, branch). */
  repoPath: text("repo_path").notNull(),
  branch: text("branch").notNull(),
  status: text("status").notNull(),
  engine: text("engine").notNull(),
  model: text("model"),
  diffHash: text("diff_hash"),
  /** JSON array of ReviewGroup. */
  groups: text("groups").notNull().default("[]"),
  /** JSON array of reviewed group names. */
  reviewedGroups: text("reviewed_groups").notNull().default("[]"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export type ReviewRow = typeof reviews.$inferSelect;

// Kept in lockstep with the drizzle tables above; a drizzle-kit migration
// pipeline replaces this once the schema outgrows hand-managed DDL.
const DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  model TEXT,
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
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_path TEXT NOT NULL,
  branch TEXT NOT NULL,
  status TEXT NOT NULL,
  engine TEXT NOT NULL,
  model TEXT,
  diff_hash TEXT,
  groups TEXT NOT NULL DEFAULT '[]',
  reviewed_groups TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS reviews_repo_branch ON reviews (repo_path, branch);
`;

/**
 * Reviews briefly existed keyed by CR/session before moving to branch-level
 * subjects. Pre-release, so an old-shape table is simply dropped and
 * recreated by the DDL; reviews regenerate on demand.
 */
function dropSubjectKeyedReviews(sqlite: InstanceType<typeof Database>): void {
  // SAFETY: SQLite's table_info pragma returns rows containing a string name column.
  const columns = new Set(
    (sqlite.pragma("table_info(reviews)") as Array<{ name: string }>).map((c) => c.name),
  );
  if (columns.has("cr_id")) sqlite.exec("DROP TABLE reviews;");
}

/** Columns added after the sessions table first shipped; applied to old dbs. */
const SESSION_COLUMN_MIGRATIONS = {
  model: "ALTER TABLE sessions ADD COLUMN model TEXT",
  title_source: "ALTER TABLE sessions ADD COLUMN title_source TEXT",
  branch: "ALTER TABLE sessions ADD COLUMN branch TEXT",
  cr_id: "ALTER TABLE sessions ADD COLUMN cr_id INTEGER",
  archived: "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
} satisfies Record<string, string>;

export type Db = ReturnType<typeof openDb>;

/** Opens (creating if needed) the daemon database. Use ":memory:" in tests. */
export function openDb(path: string) {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  dropSubjectKeyedReviews(sqlite);
  sqlite.exec(DDL);
  // SAFETY: SQLite's table_info pragma returns rows containing a string name column.
  const existing = new Set(
    (sqlite.pragma("table_info(sessions)") as Array<{ name: string }>).map((c) => c.name),
  );
  for (const [column, statement] of Object.entries(SESSION_COLUMN_MIGRATIONS)) {
    if (!existing.has(column)) sqlite.exec(statement);
  }
  return drizzle(sqlite, { schema: { sessions, changeRequests, reviews } });
}
