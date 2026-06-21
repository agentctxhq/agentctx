/**
 * Graph entity helpers for deterministic observation capture (ADR-012/014):
 * upsert `nodes` rows for files and branches, and link records to them via
 * `record_entities`.
 */
import type { Database } from "better-sqlite3";
import { ulid } from "../storage/ulid.js";

export type NodeKind = "file" | "symbol" | "package" | "module" | "branch";

/** Insert-or-fetch a node by its `(project_id, name)`. Returns the node id. */
export function upsertNode(db: Database, projectId: string, kind: NodeKind, name: string): string {
  db.prepare("INSERT OR IGNORE INTO nodes (id, project_id, kind, name) VALUES (?, ?, ?, ?)").run(
    ulid(),
    projectId,
    kind,
    name,
  );
  // Scope the lookup to the project: nodes are unique per `(project_id, name)`,
  // so two projects sharing a node name (e.g. a `main` branch) must not resolve
  // to each other's node and cross-link their records.
  const row = db
    .prepare("SELECT id FROM nodes WHERE project_id = ? AND name = ?")
    .get(projectId, name) as { id: string } | undefined;
  if (row === undefined) {
    throw new Error(`node "${name}" vanished after upsert`);
  }
  return row.id;
}

export function linkRecordToEntity(db: Database, recordId: string, entityId: string): void {
  db.prepare("INSERT OR IGNORE INTO record_entities (record_id, entity_id) VALUES (?, ?)").run(
    recordId,
    entityId,
  );
}
