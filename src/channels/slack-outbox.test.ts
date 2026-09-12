import { describe, it, expect, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackOutbox } from './slack-outbox.js';

describe('durable Slack delivery', () => {
  it('leaves paused deliveries pending without transport attempts', async () => {
    const db = new Database(':memory:');
    try {
      const box = new SlackOutbox(db);
      const id = box.enqueue('T1', 'thread', 'answer', 1);
      const send = vi.fn();
      await box.drain('T1', send, 2, () => false);
      expect(box.get(id)).toMatchObject({ status: 'pending', attempts: 0 });
      expect(send).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
  it('recovers a pending reply from a reopened database with its original thread', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slack-outbox-'));
    let db = new Database(join(dir, 'test.db'));
    try {
      const id = new SlackOutbox(db).enqueue(
        'T1',
        'slack:C1:thread:1789227865.598699',
        'answer',
        1,
      );
      db.close();
      db = new Database(join(dir, 'test.db'));
      const box = new SlackOutbox(db);
      const send = vi.fn().mockResolvedValue('1789227890.000001');
      await box.drain('T1', send, 2);
      expect(send.mock.calls[0][0].jid).toBe(
        'slack:C1:thread:1789227865.598699',
      );
      expect(box.get(id)).toMatchObject({
        status: 'delivered',
        attempts: 1,
        remote_ts: '1789227890.000001',
      });
      await box.drain('T1', send, 3);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('holds ambiguous network failures instead of automatically repeating them', async () => {
    const db = new Database(':memory:');
    try {
      const box = new SlackOutbox(db);
      const id = box.enqueue('T1', 'thread', 'answer', 1);
      const send = vi.fn().mockRejectedValue(new Error('timeout'));
      await box.drain('T1', send, 2);
      box.recover('T1');
      await box.drain('T1', send, 100000);
      expect(box.get(id)?.status).toBe('uncertain');
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
  it('bounds rate-limit retries and applies delay to other queued replies', async () => {
    const db = new Database(':memory:');
    try {
      const box = new SlackOutbox(db);
      const id = box.enqueue('T1', 'thread', 'first', 1);
      box.enqueue('T1', 'other-thread', 'second', 2);
      const send = vi.fn().mockRejectedValue({
        code: 'slack_webapi_rate_limited_error',
        retryAfter: 10,
      });
      await box.drain('T1', send, 3);
      box.enqueue('T1', 'new-thread', 'arrived during backoff', 4);
      await box.drain('T1', send, 4);
      expect(send).toHaveBeenCalledTimes(1);
      for (let n = 1; n < 5; n++) await box.drain('T1', send, 3 + n * 10000);
      expect(box.get(id)).toMatchObject({ status: 'failed', attempts: 5 });
    } finally {
      db.close();
    }
  });
  it('holds interrupted sends on recovery and leaves other workspaces alone', () => {
    const db = new Database(':memory:');
    try {
      const box = new SlackOutbox(db);
      const id = box.enqueue('T1', 'thread', 'answer', 1);
      const other = box.enqueue('T2', 'thread', 'other', 1);
      db.prepare("UPDATE slack_outbox SET status='sending'").run();
      box.recover('T1');
      expect(box.get(id)?.status).toBe('uncertain');
      expect(box.get(other)?.status).toBe('sending');
    } finally {
      db.close();
    }
  });
  it('claims a queued reply only once during concurrent drains', async () => {
    const db = new Database(':memory:');
    try {
      const box = new SlackOutbox(db);
      box.enqueue('T1', 'thread', 'answer', 1);
      const send = vi.fn().mockResolvedValue('123.000001');
      await Promise.all([box.drain('T1', send, 2), box.drain('T1', send, 2)]);
      expect(send).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
});
