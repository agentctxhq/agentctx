import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkRecordToEntity, upsertNode } from "../../src/hooks/entities.js";
import { insertRecord } from "../../src/storage/records.js";
import { type TempDb, openTempDb } from "./helpers.js";

describe("upsertNode — per-project node scoping (issue #78)", () => {
  let tmp: TempDb;

  beforeEach(() => {
    tmp = openTempDb();
  });

  afterEach(() => {
    tmp.cleanup();
  });

  it("gives two projects sharing a node name distinct node ids", () => {
    const a = upsertNode(tmp.db, "projectA", "branch", "main");
    const b = upsertNode(tmp.db, "projectB", "branch", "main");

    expect(a).not.toBe(b);
  });

  it("links a record to its own project's node, not another project's", () => {
    // Project A claims the `main` branch node first.
    const nodeA = upsertNode(tmp.db, "projectA", "branch", "main");

    // Project B's record must link to project B's `main` node.
    const recordB = insertRecord(tmp.db, {
      projectId: "projectB",
      type: "decision",
      title: "Release cut",
      body: "Tagged from main",
      source: "cli",
    });
    const nodeB = upsertNode(tmp.db, "projectB", "branch", "main");
    linkRecordToEntity(tmp.db, recordB.id, nodeB);

    expect(nodeB).not.toBe(nodeA);

    const linkedNodeId = (
      tmp.db
        .prepare("SELECT entity_id FROM record_entities WHERE record_id = ?")
        .get(recordB.id) as { entity_id: string }
    ).entity_id;
    expect(linkedNodeId).toBe(nodeB);

    const linkedProjectId = (
      tmp.db.prepare("SELECT project_id FROM nodes WHERE id = ?").get(linkedNodeId) as {
        project_id: string;
      }
    ).project_id;
    expect(linkedProjectId).toBe("projectB");
  });

  it("is idempotent within a project — same (project, name) resolves to one node", () => {
    const first = upsertNode(tmp.db, "projectA", "branch", "main");
    const second = upsertNode(tmp.db, "projectA", "branch", "main");

    expect(second).toBe(first);

    const count = (
      tmp.db
        .prepare("SELECT COUNT(*) AS n FROM nodes WHERE project_id = ? AND name = ?")
        .get("projectA", "main") as { n: number }
    ).n;
    expect(count).toBe(1);
  });

  it("enforces uniqueness per (project_id, name), not globally on name", () => {
    upsertNode(tmp.db, "projectA", "branch", "main");
    upsertNode(tmp.db, "projectB", "branch", "main");

    const names = (
      tmp.db.prepare("SELECT name FROM nodes WHERE name = 'main'").all() as Array<{ name: string }>
    ).length;
    // Both projects keep their own `main` node — the global UNIQUE would have
    // collapsed these to a single row.
    expect(names).toBe(2);
  });
});
