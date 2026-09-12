import { createHash } from 'node:crypto';

const CHANNEL = '[CG][A-Z0-9]+';
const TS = '\\d+\\.\\d{6}';
const destination = new RegExp(`^slack:(${CHANNEL}):thread:(${TS})$`);

export function slackDestination(jid: string): {
  channel: string;
  thread_ts: string;
} {
  const match = destination.exec(jid);
  if (!match)
    throw new Error('Slack replies require an explicit thread destination');
  return { channel: match[1], thread_ts: match[2] };
}

export function threadFolder(jid: string): string {
  slackDestination(jid);
  return `slack_${createHash('sha256').update(jid).digest('hex').slice(0, 40)}`;
}

export interface SlackInput {
  channel?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  subtype?: string;
  text?: string;
}

export interface SlackPolicy {
  workspace: string;
  channels: Set<string>;
  users: Set<string>;
  // Exact user:app_id pair or bot:bot_id. No display names or rendered labels.
  agents: Set<string>;
}

export function routeSlackInput(
  event: SlackInput,
  team: string,
  self: string,
  policy: SlackPolicy,
) {
  if (
    team !== policy.workspace ||
    !event.channel ||
    !policy.channels.has(event.channel)
  )
    return null;
  if (!event.ts || !new RegExp(`^${TS}$`).test(event.ts)) return null;
  if (event.user === self || (event.subtype && event.subtype !== 'bot_message'))
    return null;
  const agent = !!(
    event.bot_id ||
    event.app_id ||
    event.subtype === 'bot_message'
  );
  const identity =
    event.app_id && event.user
      ? `${event.user}:${event.app_id}`
      : `bot:${event.bot_id || ''}`;
  if (
    agent
      ? !policy.agents.has(identity)
      : !event.user || !policy.users.has(event.user)
  )
    return null;
  // Deliberate task syntax prevents names in status messages from triggering work.
  const request =
    /^TASK Andy\s+(TR-[A-Z0-9][A-Z0-9-]{0,47})\s+([\s\S]+)$/i.exec(
      event.text || '',
    );
  if (!request || request[2].length > 12000) return null;
  const root = event.thread_ts || event.ts;
  const jid = `slack:${event.channel}:thread:${root}`;
  slackDestination(jid);
  return {
    jid,
    taskId: request[1].toUpperCase(),
    prompt: request[2],
    agent,
    sender: agent ? identity : event.user!,
    taskKey: `${team}:${event.channel}:${request[1].toUpperCase()}:andy`,
  };
}
