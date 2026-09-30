const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

function fixture(t, uid) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-agent-permission-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  const runtime = path.join(directory, 'runtime');
  fs.mkdirSync(bin); fs.mkdirSync(runtime);
  const log = path.join(directory, 'operations.log');
  fs.writeFileSync(path.join(bin, 'id'), `#!/bin/sh\ncase "$1" in -u) echo ${uid} ;; -un) echo fixture-user ;; *) exit 1 ;; esac\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\n[ "$1" = --user ] || exit 99\nprintf "service %s\\n" "$*" >> "$SSS_TEST_LOG"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'wget'), '#!/bin/sh\nprintf "download\\n" >> "$SSS_TEST_LOG"\ncase "$3" in */client-linux.py) cp "$SSS_TEST_PYTHON" "$2" ;; */sss-agent.service) cp "$SSS_TEST_UNIT" "$2" ;; *) exit 1 ;; esac\n', { mode: 0o755 });
  const script = path.join(directory, 'sss-agent.sh');
  // Model UID selection without using real root or a real Linux user manager.
  const source = fs.readFileSync(path.join(root, 'agent/sss-agent.sh'), 'utf8')
    .replace('local runtime="/run/user/$(id -u)"', 'local runtime="$SSS_TEST_RUNTIME"');
  const unit = path.join(directory, '.config/systemd/user/sss-agent.service');
  const client = path.join(directory, '.local/share/sss/agent/client-linux.py');
  return { directory, unit, client, log, run: (input, args = ['--worker', 'https://example.test', 'fixture-user', 'fixture-password']) => {
    fs.writeFileSync(script, source);
    const result = spawnSync('bash', [script, ...args], {
    encoding: 'utf8', input,
    env: { ...process.env, HOME: directory, PATH: `${bin}:${process.env.PATH}`,
      GITHUB_RAW_URL: 'https://raw.githubusercontent.com/example/repo/test',
      SSS_TEST_LOG: log, SSS_TEST_RUNTIME: runtime,
      SSS_TEST_PYTHON: path.join(root, 'agent/client-linux.py'), SSS_TEST_UNIT: path.join(root, 'agent/sss-agent.service') },
    });
    assert.equal(fs.existsSync(script), false, 'installer is deleted on every exit, including rejection');
    return result;
  } };
}

test('ordinary user installs without a root prompt or elevation', t => {
  const f = fixture(t, 1000);
  const result = f.run('');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /确认以 root|sudo/);
  assert.ok(fs.existsSync(f.client));
  assert.match(fs.readFileSync(f.log, 'utf8'), /--user enable --now sss-agent/);
});

for (const [label, input] of [['declines', 'n\n'], ['defaults to rejection', '\n'], ['rejects invalid input', 'continue\n'], ['receives EOF', '']]) {
  test(`root install cancels before side effects when it ${label}`, t => {
    const f = fixture(t, 0);
    const result = f.run(input);
    assert.notEqual(result.status, 0);
    assert.match(result.stdout, /确认以 root/);
    assert.match(result.stdout, /取消安装/);
    assert.equal(fs.existsSync(f.log), false, 'no download or service commands');
    assert.equal(fs.existsSync(f.client), false);
    assert.equal(fs.existsSync(f.unit), false);
  });
}

test('root confirmation allows installation into the current home using its user service', t => {
  const f = fixture(t, 0);
  const result = f.run('y\n');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /以 root 权限运行/);
  assert.ok(result.stdout.indexOf('确认以 root') < result.stdout.indexOf('正在下载'));
  assert.ok(fs.existsSync(f.client));
  assert.match(fs.readFileSync(f.unit, 'utf8'), /USER=fixture-user/);
  assert.match(fs.readFileSync(f.log, 'utf8'), /--user restart sss-agent/);
});

test('root menu update requires a new confirmation and preserves installation on rejection', t => {
  const f = fixture(t, 0);
  assert.equal(f.run('yes\n').status, 0);
  const unit = fs.readFileSync(f.unit, 'utf8');
  const client = fs.readFileSync(f.client, 'utf8');
  const log = fs.readFileSync(f.log, 'utf8');
  for (const input of ['1\nn\n', '1\n']) {
    const rejected = f.run(input, []);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stdout, /确认以 root/);
    assert.equal(fs.readFileSync(f.unit, 'utf8'), unit);
    assert.equal(fs.readFileSync(f.client, 'utf8'), client);
    assert.equal(fs.readFileSync(f.log, 'utf8'), log);
  }
  const update = f.run('1\ny\n', []);
  assert.equal(update.status, 0, update.stdout + update.stderr);
  assert.match(update.stdout, /确认以 root/);
  assert.equal(fs.readFileSync(f.unit, 'utf8'), unit, 'update retains node credentials');
  assert.notEqual(fs.readFileSync(f.log, 'utf8'), log);
});


test('Agent installer removes itself on exit and uninstall without deleting unrelated files', t => {
  const f = fixture(t, 1000);
  const unrelated = path.join(f.directory, 'keep.txt');
  fs.writeFileSync(unrelated, 'preserve');
  assert.equal(f.run('').status, 0);
  assert.equal(f.run('0\n', []).status, 0);
  assert.ok(fs.existsSync(f.client), 'menu exit does not uninstall Agent');
  assert.equal(f.run('2\n', []).status, 0);
  assert.equal(fs.existsSync(f.client), false);
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'preserve');
});
