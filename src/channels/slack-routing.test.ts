import { describe, it, expect, beforeEach } from 'vitest';
import {
  routeSlackInput,
  slackDestination,
  threadFolder,
  type SlackPolicy,
} from './slack-routing.js';
import {
  _initTestDatabase,
  storeChatMetadata,
  storeSlackTask,
  getNewMessages,
  getMessagesSince,
  setRegisteredGroup,
  createTask,
  getTaskById,
} from '../db.js';
import { routeOutbound } from '../router.js';

const policy: SlackPolicy = {
  workspace: 'T123',
  channels: new Set(['C123']),
  users: new Set(['U123']),
  agents: new Set(['U123:A123']),
};
const input = {
  channel: 'C123',
  ts: '1789227865.598699',
  user: 'U123',
  text: 'TASK Andy TR-1 Report the time',
};
const route = (change = {}, team = 'T123') =>
  routeSlackInput({ ...input, ...change }, team, 'USELF', policy);

describe('Slack task boundaries', () => {
  it('keeps roots and replies on the original thread with stable folders', () => {
    const first = route()!;
    const reply = route({ ts: '1789227869.826409', thread_ts: input.ts })!;
    expect(reply.jid).toBe(first.jid);
    expect(slackDestination(reply.jid)).toEqual({
      channel: 'C123',
      thread_ts: input.ts,
    });
    expect(threadFolder(reply.jid)).toBe(threadFolder(first.jid));
    expect(route({ ts: '1789227870.000001' })!.jid).not.toBe(first.jid);
  });
  it.each([
    { channel: 'COTHER' },
    { user: 'UOTHER' },
    { user: 'USELF' },
    { subtype: 'message_changed' },
    { subtype: 'message_deleted' },
    { bot_id: 'BOTHER', user: undefined },
    { app_id: 'AOTHER' },
    { text: 'Andy: deploy healthy' },
    { text: 'Cowork: taking TR-1' },
    { text: 'TASK Andy TR-1 ' },
    { ts: 'invalid' },
  ])('does not dispatch invalid or unsolicited input %j', (event) => {
    expect(route(event)).toBeNull();
  });
  it('rejects other workspaces', () => {
    expect(route({}, 'TOTHER')).toBeNull();
  });
  it('preserves app provenance and requires exact configured identity', () => {
    expect(route({ app_id: 'A123' })).toMatchObject({
      agent: true,
      sender: 'U123:A123',
    });
    expect(route({ app_id: 'A123', user: 'UOTHER' })).toBeNull();
  });
  it('refuses bare or malformed outbound destinations', () => {
    expect(() => slackDestination('slack:C123')).toThrow();
    expect(() => slackDestination('slack:C123:thread:../../etc')).toThrow();
  });
});

describe('durable dispatch and destination propagation', () => {
  beforeEach(() => {
    _initTestDatabase();
  });
  function accept(ts: string, task: string, bot = false) {
    const jid = `slack:C123:thread:${ts}`;
    storeChatMetadata(jid, '2026-09-12T12:00:00.000Z');
    const msg = {
      id: ts,
      chat_jid: jid,
      sender: 'U123:A123',
      sender_name: 'Agent request',
      content: 'Task ' + task,
      timestamp: '2026-09-12T12:00:00.000Z',
      is_bot_message: bot,
    };
    return { jid, accepted: storeSlackTask(msg, `T123:C123:${task}:andy`) };
  }
  it('deduplicates task ids across different posts and threads', () => {
    expect(accept(input.ts, 'TR-1').accepted).toBe(true);
    expect(accept(input.ts, 'TR-1').accepted).toBe(false);
    expect(accept('1789227870.000001', 'TR-1').accepted).toBe(false);
    expect(
      getNewMessages([`slack:C123:thread:${input.ts}`], '', 'Andy').messages,
    ).toHaveLength(1);
  });
  it('retains authorized bot requests without removing global bot exclusion', () => {
    const first = accept(input.ts, 'TR-1', true);
    expect(getMessagesSince(first.jid, '', 'Andy')).toHaveLength(1);
  });
  it('persists separate thread destinations into delayed tasks and routes replies correctly', async () => {
    const first = accept(input.ts, 'TR-1');
    const second = accept('1789227870.000001', 'TR-2');
    for (const [id, jid] of [
      ['job1', first.jid],
      ['job2', second.jid],
    ]) {
      setRegisteredGroup(jid, {
        name: id,
        folder: threadFolder(jid),
        trigger: '@Andy',
        added_at: '2026-09-12T00:00:00Z',
      });
      createTask({
        id,
        group_folder: threadFolder(jid),
        chat_jid: jid,
        prompt: 'check',
        schedule_type: 'once',
        schedule_value: '2026-09-12T00:00:00Z',
        context_mode: 'isolated',
        next_run: '2026-09-12T00:00:00Z',
        status: 'active',
        created_at: '2026-09-12T00:00:00Z',
      });
    }
    const sent: unknown[] = [];
    const channel = {
      name: 'slack',
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      ownsJid: (j: string) => j.startsWith('slack:'),
      sendMessage: async (j: string, text: string) => {
        sent.push({ ...slackDestination(j), text });
      },
    };
    // A fresh read, as after restart, uses only persisted task data.
    await routeOutbound([channel], getTaskById('job2')!.chat_jid, 'second');
    await routeOutbound([channel], getTaskById('job1')!.chat_jid, 'first');
    expect(sent).toEqual([
      { channel: 'C123', thread_ts: '1789227870.000001', text: 'second' },
      { channel: 'C123', thread_ts: input.ts, text: 'first' },
    ]);
  });
});
