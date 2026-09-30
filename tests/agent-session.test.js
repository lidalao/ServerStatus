const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

async function fixture(t, { bus = true, unavailable = false, recover = '' } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-agent-session-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = path.join(directory, 'runtime');
  const bin = path.join(directory, 'bin');
  fs.mkdirSync(runtime); fs.mkdirSync(bin);
  if (bus) {
    const server = net.createServer();
    server.listen(path.join(runtime, 'bus'));
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
  }
  fs.writeFileSync(path.join(bin, 'systemctl'), `#!/bin/bash
[ "$1" = --user ] || [ "$SSS_TEST_RECOVER" != "" ] || exit 99
[ "$XDG_RUNTIME_DIR" = "$SSS_TEST_RUNTIME" ] || exit 98
[ "$DBUS_SESSION_BUS_ADDRESS" = "$SSS_TEST_BUS" ] || exit 97
if [ "$SSS_TEST_RECOVER" != "" ] && [ "$1" != --user ]; then
  [ "$1" = start ] || exit 99
  [ "$2" = "user@$(id -u).service" ] || exit 96
  touch "$SSS_TEST_READY"
  exit 0
fi
${unavailable ? 'echo "Failed to connect to bus: Permission denied" >&2; exit 1' : 'if [ "$SSS_TEST_RECOVER" != "" ] && [ ! -f "$SSS_TEST_READY" ]; then exit 1; fi; exit 0'}
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'loginctl'), `#!/bin/bash
printf 'loginctl %s\\n' "$*" >> "$SSS_TEST_LOG"
case "$SSS_TEST_RECOVER" in
  direct) touch "$SSS_TEST_READY" ;;
  sudo) [ "$1" != --no-ask-password ] || exit 1 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sudo'), `#!/bin/bash
printf 'sudo %s\\n' "$*" >> "$SSS_TEST_LOG"
[ "$SSS_TEST_RECOVER" = sudo ] || exit 1
exec "$@"
`, { mode: 0o755 });
  // Redirect the standard runtime path into a fixture; all connection logic is unchanged.
  const source = fs.readFileSync(path.join(root, 'agent/sss-agent.sh'), 'utf8')
    .split('\npre_check\n')[0].replace('local runtime="/run/user/$(id -u)"', 'local runtime="$SSS_TEST_RUNTIME"');
  const script = path.join(directory, 'session.sh');
  fs.writeFileSync(script, source + '\nensure_user_manager\n');
  const log = path.join(directory, 'commands.log');
  return { runtime, log, run: overrides => spawnSync('bash', [script], {
    encoding: 'utf8', env: { ...process.env, HOME: directory, PATH: `${bin}:${process.env.PATH}`,
      SSS_TEST_READY: path.join(directory, 'ready'), SSS_TEST_RECOVER: recover, SSS_TEST_LOG: log, SSS_TEST_RUNTIME: runtime, SSS_TEST_BUS: bus ? `unix:path=${runtime}/bus` : '', ...overrides },
  }) };
}

test('Agent repairs missing user-session environment', async t => {
  const f = await fixture(t);
  const result = f.run({ XDG_RUNTIME_DIR: '', DBUS_SESSION_BUS_ADDRESS: '' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('Agent replaces inherited foreign runtime and D-Bus variables', async t => {
  const f = await fixture(t);
  const result = f.run({ XDG_RUNTIME_DIR: '/run/user/foreign', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/foreign/bus' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('Agent clears stale bus address when user manager uses its private socket', async t => {
  const f = await fixture(t, { bus: false });
  const result = f.run({ DBUS_SESSION_BUS_ADDRESS: 'unix:path=/foreign/bus' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('unavailable user manager gives concrete diagnostics and returns failure', async t => {
  const f = await fixture(t, { unavailable: true });
  const result = f.run({});
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /loginctl show-user/);
  assert.match(result.stdout, /loginctl enable-linger/);
  assert.match(result.stdout, /systemctl start user@\d+\.service/);
  assert.match(result.stdout, /无法取得主机授权/);
});


test('Agent automatically enables own linger when logind policy allows it', async t => {
  const f = await fixture(t, { recover: 'direct' });
  const result = f.run({ XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const log = fs.readFileSync(f.log, 'utf8');
  assert.match(log, /loginctl --no-ask-password enable-linger/);
  assert.doesNotMatch(log, /sudo/);
});

test('Agent obtains host authorization and starts only its own user manager', async t => {
  const f = await fixture(t, { recover: 'sudo' });
  const result = f.run({ XDG_RUNTIME_DIR: '/run/user/0', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/0/bus' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const log = fs.readFileSync(f.log, 'utf8');
  assert.match(log, /loginctl enable-linger/);
  // Root needs no sudo; non-root repairs use sudo only for host setup.
  assert.ok(result.stdout.includes('自动修复'));
});
