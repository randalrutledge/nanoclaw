import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  auth: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('@slack/bolt', () => ({
  LogLevel: { ERROR: 'error' },
  App: class {
    client = { auth: { test: mocks.auth }, chat: { postMessage: mocks.post } };
    event() {}
    error() {}
    start = mocks.start;
    stop = mocks.stop;
  },
}));
import { SlackChannel } from './slack.js';
import {
  _initTestDatabase,
  isSlackStopped,
  getNewMessages,
  getAllRegisteredGroups,
  setRegisteredGroup,
  storeChatMetadata,
  storeMessage,
} from '../db.js';
import type { RegisteredGroup } from '../types.js';
const event = {
  channel: 'C123',
  user: 'U123',
  ts: '1789227865.598699',
  text: 'TASK Andy TR-1 Report time',
};
function setup() {
  const parent: RegisteredGroup = {
    name: 'team',
    folder: 'team',
    trigger: '@Andy',
    added_at: '2026-09-12',
  };
  setRegisteredGroup('slack:C123', parent);
  return new SlackChannel(
    'not-a-real-token',
    'not-a-real-app-token',
    {
      registeredGroups: getAllRegisteredGroups,
      registerConversation: setRegisteredGroup,
      onChatMetadata: storeChatMetadata,
      onMessage: (_, m) => storeMessage(m),
    },
    {
      workspace: 'T123',
      channels: new Set(['C123']),
      users: new Set(['U123']),
      agents: new Set(['U123:A123']),
    },
  );
}
beforeEach(() => {
  _initTestDatabase();
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ team_id: 'T123', user_id: 'USELF' });
  mocks.post.mockResolvedValue({ ok: true, ts: '1789227890.000001' });
  mocks.start.mockResolvedValue(undefined);
});
describe('Slack adapter', () => {
  it('persists STOP across channel recreation and blocks pending and new input and output', async () => {
    const channel = setup();
    await channel.connect();
    await channel.receive(event, 'T123');
    const jid = `slack:C123:thread:${event.ts}`;
    await channel.receive({ ...event, text: 'STOP Andy' }, 'T123');
    expect(isSlackStopped(jid)).toBe(true);
    expect(getNewMessages([jid], '', 'Andy').messages).toHaveLength(0);
    await expect(channel.sendMessage(jid, 'late result')).rejects.toThrow(
      'stopped',
    );
    await channel.disconnect();
    const second = setup();
    await second.connect();
    await second.receive(
      { ...event, ts: '1789228000.000001', text: 'TASK Andy TR-2 New work' },
      'T123',
    );
    expect(
      getAllRegisteredGroups()['slack:C123:thread:1789228000.000001'],
    ).toBeUndefined();
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await second.disconnect();
  });
  it('ignores STOP from an unauthorized sender or workspace', async () => {
    const channel = setup();
    await channel.connect();
    await channel.receive(
      { ...event, user: 'UOTHER', text: 'STOP Andy' },
      'T123',
    );
    await channel.receive({ ...event, text: 'STOP Andy' }, 'TOTHER');
    expect(isSlackStopped('slack:C123')).toBe(false);
    await channel.disconnect();
  });
  it('ignores input after disconnect instead of persisting new work', async () => {
    const channel = setup();
    await channel.connect();
    await channel.disconnect();
    await channel.receive(event, 'T123');
    expect(
      getAllRegisteredGroups()[`slack:C123:thread:${event.ts}`],
    ).toBeUndefined();
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('rejects delayed output when its parent becomes an elevated group', async () => {
    const channel = setup();
    await channel.connect();
    await channel.receive(event, 'T123');
    const parent = getAllRegisteredGroups()['slack:C123'];
    setRegisteredGroup('slack:C123', { ...parent, isMain: true });
    await expect(
      channel.sendMessage(`slack:C123:thread:${event.ts}`, 'late result'),
    ).rejects.toThrow('not registered/allowed');
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it('registers isolated non-main threads and keeps duplicate tasks from dispatching', async () => {
    const channel = setup();
    await channel.connect();
    await channel.receive(event, 'T123');
    await channel.receive(event, 'T123');
    const jid = `slack:C123:thread:${event.ts}`;
    expect(getAllRegisteredGroups()[jid]).toMatchObject({
      isMain: undefined,
      requiresTrigger: false,
    });
    expect(getAllRegisteredGroups()[jid].containerConfig).toBeUndefined();
    expect(getNewMessages([jid], '', 'Andy').messages).toHaveLength(1);
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0][0]).toMatchObject({
      channel: 'C123',
      thread_ts: event.ts,
      text: 'Andy: accepted TR-1.',
    });
  });
  it('continues using persisted task receipts after connector recreation', async () => {
    const first = setup();
    await first.connect();
    await first.receive(event, 'T123');
    await first.disconnect();
    const second = setup();
    await second.connect();
    await second.receive(event, 'T123');
    expect(mocks.post).toHaveBeenCalledTimes(1);
    await second.sendMessage(`slack:C123:thread:${event.ts}`, 'done');
    expect(mocks.post.mock.calls[1][0].thread_ts).toBe(event.ts);
  });
  it('does not lose the task when acknowledgment delivery fails', async () => {
    mocks.post.mockRejectedValueOnce(new Error('network'));
    const channel = setup();
    await channel.connect();
    await channel.receive(event, 'T123');
    expect(
      getNewMessages([`slack:C123:thread:${event.ts}`], '', 'Andy').messages,
    ).toHaveLength(1);
    await channel.receive(event, 'T123');
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });
  it('does not widen Telegram bot filters', async () => {
    storeChatMetadata('tg:123', '2026-09-12T00:00:00Z');
    storeMessage({
      id: '1',
      chat_jid: 'tg:123',
      sender: 'bot',
      sender_name: 'bot',
      content: 'do work',
      timestamp: '2026-09-12T00:00:00Z',
      is_bot_message: true,
    });
    expect(getNewMessages(['tg:123'], '', 'Andy').messages).toHaveLength(0);
  });
  it('rejects startup in the wrong workspace', async () => {
    mocks.auth.mockResolvedValue({ team_id: 'TOTHER', user_id: 'USELF' });
    const channel = setup();
    await expect(channel.connect()).rejects.toThrow('mismatch');
    expect(mocks.start).not.toHaveBeenCalled();
    expect(channel.isConnected()).toBe(false);
  });
  it('ignores own posts and normal agent status replies', async () => {
    const channel = setup();
    await channel.connect();
    await channel.receive({ ...event, user: 'USELF', bot_id: 'BSELF' }, 'T123');
    await channel.receive(
      { ...event, app_id: 'A123', text: 'Cowork: taking TR-1' },
      'T123',
    );
    expect(mocks.post).not.toHaveBeenCalled();
  });
  it('stores approved agent provenance without treating it as human input', async () => {
    const channel = setup();
    await channel.connect();
    await channel.receive({ ...event, app_id: 'A123' }, 'T123');
    const messages = getNewMessages(
      [`slack:C123:thread:${event.ts}`],
      '',
      'Andy',
    ).messages;
    expect(messages[0].sender).toBe('U123:A123');
    expect(messages[0].sender_name).toBe('Agent request (U123:A123)');
  });
});
