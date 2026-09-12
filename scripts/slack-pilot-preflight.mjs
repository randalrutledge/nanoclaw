// Read-only preflight. Uses exported host environment; never prints token values.
const env = process.env;
const failures = [];
const check = (label, ok) => {
  console.log((ok ? 'PASS ' : 'FAIL ') + label);
  if (!ok) failures.push(label);
};
check('dedicated bot token format', /^xoxb-/.test(env.SLACK_BOT_TOKEN || ''));
check('Socket Mode app token format', /^xapp-/.test(env.SLACK_APP_TOKEN || ''));
check('pilot workspace', env.SLACK_WORKSPACE_ID === 'T0APPAC1U5S');
check('only pilot channel allowed', env.SLACK_CHANNEL_IDS === 'C0C19JFNASH');
check('initial human-only sender', env.SLACK_USER_IDS === 'U0APDB1DF1R');
check('agent dispatch disabled for first pilot', !(env.SLACK_AGENT_IDENTITIES || '').trim());
console.log('Offline configuration check only. Token validity, app identity, membership and host readiness require separate verification.');
process.exitCode = failures.length ? 1 : 0;
