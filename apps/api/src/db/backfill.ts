import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

/**
 * Idempotent data fixes run at startup, after the schema migrations.
 *
 * - Scripts written by a `translate_script` job used to be saved as source "ai", so hiding or
 *   reordering pages in the translated project marked them 需更新 and 下一步 offered to replace
 *   them with freshly generated scripts. They are translations: mark the revisions that job
 *   created (same project, created while it ran) as such.
 */
export async function runBackfills(db: Db): Promise<void> {
  await db.execute(sql`
    UPDATE script_revisions AS r
    SET source = 'translation'
    FROM scenes AS s, jobs AS j
    WHERE r.scene_id = s.id
      AND j.project_id = s.project_id
      AND j.type = 'translate_script'
      AND r.source = 'ai'
      AND j.started_at IS NOT NULL
      AND r.created_at >= j.started_at
      AND r.created_at <= COALESCE(j.finished_at, now())
  `);
}
