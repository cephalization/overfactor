import Database from "better-sqlite3";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.ts";
import { SessionStore } from "../src/store.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe("database migrations", () => {
  it("adds archived=false and model=null to an existing sessions table", async () => {
    const directory = await mkdtemp(join(tmpdir(), "overfactor-db-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "daemon.db");
    const sqlite = new Database(path);
    sqlite.exec(`
      CREATE TABLE sessions (
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
        files_changed INTEGER,
        insertions INTEGER,
        deletions INTEGER,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO sessions (
        id, agent, state, cwd, repo_path, started_at, updated_at
      ) VALUES (
        'session-1', 'pi', 'idle', '/repo', '/repo',
        '2026-08-16T12:00:00.000Z', '2026-08-16T12:00:00.000Z'
      );
    `);
    sqlite.close();

    const store = new SessionStore(openDb(path));
    expect(store.get("session-1")).toMatchObject({ archived: false, model: null });
  });

  it("adds provider=null to existing branch reviews", async () => {
    const directory = await mkdtemp(join(tmpdir(), "overfactor-db-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "daemon.db");
    const sqlite = new Database(path);
    sqlite.exec(`
      CREATE TABLE reviews (
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
      CREATE UNIQUE INDEX reviews_repo_branch ON reviews (repo_path, branch);
      INSERT INTO reviews (
        repo_path, branch, status, engine, model, created_at, updated_at
      ) VALUES (
        '/repo', 'feat/review', 'generating', 'claude-code', 'sonnet',
        '2026-08-18T12:00:00.000Z', '2026-08-18T12:00:00.000Z'
      );
    `);
    sqlite.close();

    const store = new SessionStore(openDb(path));
    expect(store.getReview({ repoPath: "/repo", branch: "feat/review" })).toMatchObject({
      provider: null,
      model: "sonnet",
    });
  });
});
