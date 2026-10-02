import type { Queryable } from '../db/pool.js';

export async function audit(
  db: Queryable,
  actor: string,
  action: string,
  entityType: string,
  entityId: string | null,
  details: Record<string, unknown> = {},
): Promise<void> {
  await db.query(
    'insert into audit_log (actor, action, entity_type, entity_id, details) values ($1, $2, $3, $4, $5)',
    [actor, action, entityType, entityId, JSON.stringify(details)],
  );
}
