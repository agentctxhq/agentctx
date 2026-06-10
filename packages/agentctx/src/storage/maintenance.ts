/**
 * Destructive maintenance operations (`agentctx reset`).
 *
 * Unlike supersession — which never deletes (SPEC §3.5) — reset is an
 * explicit, user-confirmed hard delete of one project's namespace. Global
 * (`_global`) records and other projects are never touched.
 */
import type { Database } from "better-sqlite3";

/** Count all records in a project's own namespace, superseded included. */
export function countProjectRecords(db: Database, projectId: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM records WHERE project_id = ?")
    .get(projectId) as { n: number };
  return row.n;
}

export interface ProjectResetResult {
  records: number;
  nodes: number;
  edges: number;
  sessions: number;
}

/**
 * Delete every row belonging to `projectId` — records (FTS rows follow via
 * triggers), entity links, graph nodes/edges, and session metadata — in one
 * transaction.
 */
export function deleteProjectData(db: Database, projectId: string): ProjectResetResult {
  return db.transaction((): ProjectResetResult => {
    // Break supersession references into the doomed rows first: superseded_by
    // is an immediate FK, and row order within a bulk DELETE is unspecified.
    db.prepare(
      `UPDATE records SET superseded_by = NULL
       WHERE superseded_by IN (SELECT id FROM records WHERE project_id = @projectId)`,
    ).run({ projectId });

    db.prepare(
      `DELETE FROM record_entities
       WHERE record_id IN (SELECT id FROM records WHERE project_id = @projectId)
          OR entity_id IN (SELECT id FROM nodes WHERE project_id = @projectId)`,
    ).run({ projectId });

    const edges = db
      .prepare(
        `DELETE FROM edges
         WHERE from_id IN (SELECT id FROM nodes WHERE project_id = @projectId)
            OR to_id IN (SELECT id FROM nodes WHERE project_id = @projectId)`,
      )
      .run({ projectId }).changes;

    const nodes = db.prepare("DELETE FROM nodes WHERE project_id = ?").run(projectId).changes;
    const records = db.prepare("DELETE FROM records WHERE project_id = ?").run(projectId).changes;
    const sessions = db.prepare("DELETE FROM sessions WHERE project_id = ?").run(projectId).changes;

    return { records, nodes, edges, sessions };
  })();
}
