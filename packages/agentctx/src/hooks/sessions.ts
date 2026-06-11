/**
 * Session metadata writes (SPEC §3.1 `sessions`): injection self-accounting
 * (SPEC §9 — every injection records its token estimate), session end
 * timestamps, and namespace switches on cwd change.
 */
import type { Database } from "better-sqlite3";

export interface InjectionAccount {
  sessionId: string;
  projectId: string;
  tokens: number;
  at: string;
}

/** Upsert the session row and add this injection's token estimate. */
export function recordInjection(db: Database, account: InjectionAccount): void {
  db.prepare(
    `INSERT INTO sessions (session_id, project_id, started_at, tokens_injected)
     VALUES (@sessionId, @projectId, @at, @tokens)
     ON CONFLICT(session_id) DO UPDATE SET
       tokens_injected = tokens_injected + @tokens`,
  ).run(account);
}

export function markSessionEnded(db: Database, sessionId: string, at: string): void {
  db.prepare(
    `INSERT INTO sessions (session_id, ended_at) VALUES (@sessionId, @at)
     ON CONFLICT(session_id) DO UPDATE SET ended_at = @at`,
  ).run({ sessionId, at });
}

/** CwdChanged: subsequent accounting for this session attributes to the new project. */
export function setSessionProject(db: Database, sessionId: string, projectId: string): void {
  db.prepare(
    `INSERT INTO sessions (session_id, project_id) VALUES (@sessionId, @projectId)
     ON CONFLICT(session_id) DO UPDATE SET project_id = @projectId`,
  ).run({ sessionId, projectId });
}
