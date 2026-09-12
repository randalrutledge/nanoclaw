# Slack team-room candidate

Draft implementation for Saleserator coordination issue #1153. Not deployed or approved for unattended operation.

## What works locally

Socket Mode receives explicitly addressed messages such as `TASK Andy TR-2 Report the current test results`. Workspace, channel and sender allowlists apply. Plain status messages and self messages are ignored. Each Slack thread has its own registered, non-main conversation and session; its destination includes the thread timestamp, so scheduled replies retain the destination. Telegram registrations and imports must be preserved when integrating this patch.

SQLite stores task acceptance and the inbound message in one transaction. A task ID is unique per workspace/channel/Andy, including across threads. Use a new task ID for a new request. This prevents repeated acceptance, not repeated external side effects after an interrupted agent run. Separate threads do not automatically share conversational memory.

## Review and host preparation — Andy

1. Review this branch before applying it. Seven supplied core source files matched public base eba94b721ab8c7476e97d6600ca7ee4c0e53249c after line-ending normalization. The entire deployed checkout, Telegram implementation and deployed dependency lockfile were not verified.
2. Identify the real host checkout path and startup/service command on the XPS/WSL host. The macOS launchd template is not evidence of the active service. Record names and paths on #1153, never credentials.
3. Apply on an isolated branch and preserve local Telegram code and dependencies. Add the pinned dependency `@slack/bolt@5.1.0` to that checkout and regenerate its lockfile; do not replace its package files wholesale with the public baseline.
4. Run `npm run build` and `npm test` on WSL. Back up the SQLite database before any approved start: initialization adds a messages column and a task-receipt table. No production restart is authorized by this document.
5. Prepare host-only `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` for the dedicated NanoClaw Slack app with Socket Mode and private-channel message access. Keep tokens outside containers, issues and chat. Invite the app to the private team room when the pilot is approved.
6. Configure `SLACK_WORKSPACE_ID=T0APPAC1U5S`, `SLACK_CHANNEL_IDS=C0C19JFNASH`, and initially `SLACK_USER_IDS=U0APDB1DF1R`. Add Albert and Taylor only when their pilot participation is agreed. Register the parent `slack:C0C19JFNASH` through the existing group-registration mechanism as a non-main group. Child thread registrations are created on demand, without inherited mounts.
7. Leave `SLACK_AGENT_IDENTITIES` empty until sanitized raw inbound events establish the real provider fields. It accepts comma-separated exact `user:app_id` or `bot:bot_id` pairs. A rendered “Sent using Claude” marker, an app-user ID, or a name prefix is insufficient to derive those pairs or grant human authority.

## Supervised acceptance sequence

Use one fresh thread and task ID per test. Record Slack timestamps and the relevant test result on #1153.

1. Randal posts `TASK Andy TR-PILOT-1 Reply with the word ready only`. Verify acceptance and result stay in that thread.
2. Repeat the same task ID in the same thread and another thread. Neither should dispatch new work.
3. Post a plain status line; verify no dispatch. Verify Andy's own messages do not dispatch.
4. Run two requests in different threads, then a delayed reply. Verify no cross-thread response. Restart in the test environment and retry an accepted ID; verify no second acceptance.
5. After raw identity mapping is verified, Cowork posts one explicitly addressed, read-only task using the same syntax. Andy replies in that thread. Cowork reads and summarizes it manually; no schedule yet.

## Remaining limits before unattended use

- No durable outbound queue or offline history catch-up. A stored task can survive a failed acknowledgement, but a failed final reply can still be lost. Socket health is not fully reflected by `isConnected`.
- No technical stop command, execution budget, or cross-agent shared claim service. Task receipts apply to this NanoClaw database and Andy only. Prompt wording is not a security boundary for an agent's existing tools.
- No live Slack, Docker-agent, complete process restart, or multi-process race validation has been performed here. Mocked connector recreation is not a real deployment restart.
- There is a 100-thread registration cap per channel and no automatic cleanup. Responses over 3,500 characters are explicitly shortened; use linked artifacts for larger results.
- Cowork and Fable may share a provider identity. Prefixes label authors but cannot distinguish their authority. Keep pilot requests read-only, supervised, and narrowly scoped.

Do not enable hourly processing or automatic agent-to-agent chains until delivery recovery, stop behavior, attribution, duplicate and loop tests are resolved. Existing morning brief remains unchanged.

## Local validation

The 25 new routing/connector tests pass, including SQLite receipt persistence, rejection of unapproved bot/app events, independent thread destinations, delayed-task routing and failed acknowledgement retention. The original baseline suite had one Windows failure in `setup/platform.test.ts` (`commandExists('node')`); report that separately rather than changing the platform test to make this feature pass.
