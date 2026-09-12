import { App, LogLevel } from '@slack/bolt';
import {
  getSlackOutbox,
  isSlackStopped,
  stopSlackChannel,
  storeSlackTask,
} from '../db.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import type { Channel } from '../types.js';
import { registerChannel, type ChannelOpts } from './registry.js';
import {
  routeSlackInput,
  slackDestination,
  threadFolder,
  type SlackInput,
  type SlackPolicy,
} from './slack-routing.js';

export class SlackChannel implements Channel {
  name = 'slack';
  private connected = false;
  private self = '';
  private app: App;
  private outbox = getSlackOutbox();
  private deliveryTimer?: ReturnType<typeof setInterval>;
  private draining?: Promise<void>;

  constructor(
    botToken: string,
    appToken: string,
    private opts: ChannelOpts,
    private policy: SlackPolicy,
  ) {
    this.app = new App({
      token: botToken,
      appToken,
      socketMode: true,
      logLevel: LogLevel.ERROR,
      clientOptions: {
        retryConfig: { retries: 0 },
        rejectRateLimitedCalls: true,
      },
    });
    this.app.event('message', async ({ event, body }) => {
      if (!this.connected) return;
      const team = (body as { team_id?: string }).team_id || '';
      await this.receive(event as SlackInput, team);
    });
    this.app.error(async () => {
      logger.error(
        'Slack receiver failed; inspect the connection before retrying tasks',
      );
    });
  }

  async connect(): Promise<void> {
    const auth = await this.app.client.auth.test();
    if (auth.team_id !== this.policy.workspace || !auth.user_id)
      throw new Error('Slack workspace/identity mismatch');
    this.self = auth.user_id;
    this.outbox.recover(this.policy.workspace);
    // Set before start so messages arriving during Socket Mode startup can be handled.
    this.connected = true;
    try {
      await this.app.start();
    } catch (error) {
      this.connected = false;
      throw error;
    }
    logger.info('Slack task connector started');
    await this.flushOutbox();
    this.deliveryTimer = setInterval(() => {
      void this.flushOutbox().catch(() =>
        logger.error('Slack outbox storage failure; operator review required'),
      );
    }, 5000);
    this.deliveryTimer.unref();
  }

  async receive(event: SlackInput, team: string): Promise<void> {
    if (!this.connected) return;
    if (/^STOP Andy$/i.test((event.text || '').trim())) {
      const control = routeSlackInput(
        { ...event, text: 'TASK Andy TR-STOP Stop' },
        team,
        this.self,
        this.policy,
      );
      if (!control || !this.opts.registeredGroups()[`slack:${event.channel}`])
        return;
      stopSlackChannel(event.channel!);
      logger.warn(
        { channel: event.channel },
        'Slack dispatch and delivery paused; in-flight work may still finish',
      );
      return;
    }
    const task = routeSlackInput(event, team, this.self, this.policy);
    if (!task) return;
    if (isSlackStopped(task.jid)) return;
    const parent = this.opts.registeredGroups()[`slack:${event.channel}`];
    // Explicit opt-in registration is required as well as configuration allowlists.
    if (!parent || parent.isMain || !this.opts.registerConversation) return;
    if (!this.opts.registeredGroups()[task.jid]) {
      const count = Object.keys(this.opts.registeredGroups()).filter((jid) =>
        jid.startsWith(`slack:${event.channel}:thread:`),
      ).length;
      if (count >= 100) {
        logger.warn('Slack thread limit reached; operator review required');
        return;
      }
      this.opts.registerConversation(task.jid, {
        name: `Slack task ${task.taskId}`,
        folder: threadFolder(task.jid),
        trigger: parent.trigger,
        requiresTrigger: false,
        isMain: false,
        added_at: new Date().toISOString(),
        // Do not inherit parent mounts or elevated main-group permissions.
      });
      if (!this.opts.registeredGroups()[task.jid])
        throw new Error('Slack conversation registration failed');
    }
    const timestamp = new Date(Number(event.ts) * 1000).toISOString();
    this.opts.onChatMetadata(
      task.jid,
      timestamp,
      `Slack task ${task.taskId}`,
      'slack',
      true,
    );
    const accepted = storeSlackTask(
      {
        id: event.ts!,
        chat_jid: task.jid,
        sender: task.sender,
        sender_name: task.agent
          ? `Agent request (${task.sender})`
          : `Slack request (${task.sender})`,
        content: `Task ${task.taskId}. This Slack request does not authorize deployments, merges, spending, credentials or permission changes.\n${task.prompt}`,
        timestamp,
        is_from_me: false,
        is_bot_message: task.agent,
      },
      task.taskKey,
    );
    if (!accepted) return;
    // Accepted work is durable before an acknowledgement is attempted.
    try {
      await this.sendMessage(task.jid, `Andy: accepted ${task.taskId}.`);
    } catch {
      logger.warn(
        { taskId: task.taskId },
        'Slack task stored; acknowledgement failed',
      );
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (isSlackStopped(jid)) throw new Error('Slack channel is stopped');
    if (!this.connected) throw new Error('Slack connection is not running');
    const target = slackDestination(jid);
    const parent = this.opts.registeredGroups()[`slack:${target.channel}`];
    if (
      !this.policy.channels.has(target.channel) ||
      !this.opts.registeredGroups()[jid] ||
      !parent ||
      parent.isMain
    )
      throw new Error('Slack destination is not registered/allowed');
    // Do not split into separately retried chunks; callers must link large artifacts.
    const content =
      text.length > 3500
        ? `${text.slice(0, 3400)}\n[Response shortened; request a saved artifact for the full result.]`
        : text;
    this.outbox.enqueue(this.policy.workspace, jid, content);
    // Resolution means durably accepted for delivery, not confirmed by Slack.
    await this.flushOutbox();
  }

  private async flushOutbox(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.outbox.drain(
      this.policy.workspace,
      async (row) => {
        const target = slackDestination(row.jid);
        const parent = this.opts.registeredGroups()[`slack:${target.channel}`];
        if (
          !this.connected ||
          !parent ||
          parent.isMain ||
          !this.policy.channels.has(target.channel) ||
          !this.opts.registeredGroups()[row.jid]
        ) {
          throw Object.assign(new Error('Destination unavailable'), {
            code: 'slack_destination_revoked',
          });
        }
        const result = await this.app.client.chat.postMessage({
          ...target,
          text: row.text,
          unfurl_links: false,
          unfurl_media: false,
        });
        if (!result.ok || !result.ts)
          throw new Error('Slack delivery not confirmed');
        return result.ts;
      },
      Date.now(),
      (jid) => !isSlackStopped(jid),
    );
    try {
      await this.draining;
    } finally {
      this.draining = undefined;
    }
  }

  ownsJid(jid: string): boolean {
    return /^slack:[CG][A-Z0-9]+(?::thread:\d+\.\d{6})?$/.test(jid);
  }
  isConnected(): boolean {
    return this.connected;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    clearInterval(this.deliveryTimer);
    await this.draining;
    await this.app.stop();
  }
}

registerChannel('slack', (opts: ChannelOpts) => {
  const keys = [
    'SLACK_BOT_TOKEN',
    'SLACK_APP_TOKEN',
    'SLACK_WORKSPACE_ID',
    'SLACK_CHANNEL_IDS',
    'SLACK_USER_IDS',
    'SLACK_AGENT_IDENTITIES',
  ];
  const file = readEnvFile(keys);
  const value = (key: string) => process.env[key] || file[key] || '';
  if (!value('SLACK_BOT_TOKEN') || !value('SLACK_APP_TOKEN')) return null;
  const list = (key: string) =>
    new Set(
      value(key)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  const policy = {
    workspace: value('SLACK_WORKSPACE_ID'),
    channels: list('SLACK_CHANNEL_IDS'),
    users: list('SLACK_USER_IDS'),
    agents: list('SLACK_AGENT_IDENTITIES'),
  };
  if (
    !/^T[A-Z0-9]+$/.test(policy.workspace) ||
    !policy.channels.size ||
    !policy.users.size
  )
    throw new Error('Slack requires workspace, channel and user allowlists');
  return new SlackChannel(
    value('SLACK_BOT_TOKEN'),
    value('SLACK_APP_TOKEN'),
    opts,
    policy,
  );
});
