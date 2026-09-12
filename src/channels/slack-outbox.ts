import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface SlackDelivery {
  id: string;
  workspace: string;
  jid: string;
  text: string;
  status: string;
  attempts: number;
  next_attempt: number;
  remote_ts: string | null;
}

// One host process owns this database. No automatic replay of ambiguous sends.
export class SlackOutbox {
  constructor(private db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS slack_outbox (
      id TEXT PRIMARY KEY, workspace TEXT NOT NULL, jid TEXT NOT NULL,
      text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL,
      remote_ts TEXT, reason TEXT, created_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS slack_outbox_due ON slack_outbox(status, next_attempt);
    CREATE TABLE IF NOT EXISTS slack_delivery_backoff (workspace TEXT PRIMARY KEY, until_ms INTEGER NOT NULL);`);
  }

  enqueue(
    workspace: string,
    jid: string,
    text: string,
    now = Date.now(),
  ): string {
    const id = randomUUID();
    this.db
      .prepare(
        'INSERT INTO slack_outbox (id,workspace,jid,text,next_attempt,created_at) VALUES (?,?,?,?,?,?)',
      )
      .run(id, workspace, jid, text, now, now);
    return id;
  }

  recover(workspace: string): void {
    this.db
      .prepare(
        "UPDATE slack_outbox SET status='uncertain', reason='interrupted_send' WHERE workspace=? AND status='sending'",
      )
      .run(workspace);
  }

  get(id: string): SlackDelivery | undefined {
    return this.db.prepare('SELECT * FROM slack_outbox WHERE id=?').get(id) as
      | SlackDelivery
      | undefined;
  }

  async drain(
    workspace: string,
    send: (row: SlackDelivery) => Promise<string>,
    now = Date.now(),
    permitted: (jid: string) => boolean = () => true,
  ): Promise<void> {
    const backoff = this.db
      .prepare('SELECT until_ms FROM slack_delivery_backoff WHERE workspace=?')
      .get(workspace) as { until_ms: number } | undefined;
    if (backoff && backoff.until_ms > now) return;
    const rows = this.db
      .prepare(
        "SELECT * FROM slack_outbox WHERE workspace=? AND status='pending' AND next_attempt<=? ORDER BY created_at,id LIMIT 20",
      )
      .all(workspace, now) as SlackDelivery[];
    for (const row of rows) {
      if (!permitted(row.jid)) continue;
      const claimed = this.db
        .prepare(
          "UPDATE slack_outbox SET status='sending', attempts=attempts+1 WHERE id=? AND status='pending'",
        )
        .run(row.id);
      if (!claimed.changes) continue;
      let remoteTs: string;
      try {
        remoteTs = await send(row);
      } catch (error) {
        const e = error as { code?: string; retryAfter?: number };
        // Only an explicit rate-limit rejection proves the send can be retried.
        const limited = e?.code === 'slack_webapi_rate_limited_error';
        const rejected =
          e?.code === 'slack_webapi_platform_error' ||
          e?.code === 'slack_destination_revoked';
        const status =
          limited && row.attempts + 1 < 5
            ? 'pending'
            : limited || rejected
              ? 'failed'
              : 'uncertain';
        const seconds = Number.isFinite(e?.retryAfter)
          ? Math.max(1, e.retryAfter!)
          : 30;
        this.db
          .prepare(
            'UPDATE slack_outbox SET status=?, next_attempt=?, reason=? WHERE id=?',
          )
          .run(
            status,
            now + seconds * 1000,
            limited ? 'rate_limited' : rejected ? 'rejected' : 'ambiguous_send',
            row.id,
          );
        if (limited) {
          this.db
            .prepare(
              'INSERT INTO slack_delivery_backoff(workspace,until_ms) VALUES (?,?) ON CONFLICT(workspace) DO UPDATE SET until_ms=MAX(until_ms,excluded.until_ms)',
            )
            .run(workspace, now + seconds * 1000);
          this.db
            .prepare(
              "UPDATE slack_outbox SET next_attempt=MAX(next_attempt,?) WHERE workspace=? AND status='pending'",
            )
            .run(now + seconds * 1000, workspace);
          break;
        }
        continue;
      }
      // A database failure here leaves 'sending'; restart holds it for review.
      this.db
        .prepare(
          "UPDATE slack_outbox SET status='delivered', remote_ts=?, reason=NULL WHERE id=?",
        )
        .run(remoteTs, row.id);
    }
  }
}
