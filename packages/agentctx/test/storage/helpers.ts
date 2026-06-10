import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "better-sqlite3";
import { openDatabase } from "../../src/storage/db.js";

export interface TempDb {
  db: Database;
  path: string;
  cleanup: () => void;
}

/** Open a fresh database in a temp dir — tests never touch ~/.agentctx. */
export function openTempDb(): TempDb {
  const dir = mkdtempSync(join(tmpdir(), "agentctx-test-"));
  const path = join(dir, "agentctx.db");
  const tmp: TempDb = {
    db: openDatabase(path),
    path,
    cleanup: () => {
      // Close via tmp.db so tests that reopen the database stay cleanable.
      if (tmp.db.open) {
        tmp.db.close();
      }
      // Windows can hold WAL file handles briefly after close — retry.
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
  return tmp;
}
