const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '..');

function fixture(t, { platform = 'Darwin', architecture = 'arm64', ready = false, missing = [], checksumFailure = false, downloadFailure = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-bootstrap-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bin = path.join(directory, 'bin');
  const home = path.join(directory, 'user');
  fs.mkdirSync(bin); fs.mkdirSync(home);
  function script(name, content) { fs.writeFileSync(path.join(bin, name), '#!/bin/bash\n' + content + '\n', { mode: 0o755 }); }
  for (const name of ['dirname', 'mktemp', 'rm', 'mv', 'mkdir', 'cat', 'tar', 'shasum', 'cp', 'chmod']) {
    const result = spawnSync('which', [name], { encoding: 'utf8' });
    assert.equal(result.status, 0, name);
    fs.symlinkSync(result.stdout.trim(), path.join(bin, name));
  }
  script('uname', `case "$1" in -s) echo ${platform} ;; -m) echo ${architecture} ;; *) exit 1 ;; esac`);
  script('node', `echo v${ready ? '23.10.0' : '18.0.0'}`);
  script('npm', 'echo 10.0.0');
  const log = path.join(directory, 'commands.log');
  const jqSource = path.join(directory, 'jq-source');
  fs.writeFileSync(jqSource, '#!/bin/bash\necho jq-fixture\n', { mode: 0o755 });
  const curlSource = path.join(directory, 'curl-source');
  fs.writeFileSync(curlSource, `#!/bin/bash
url=""; target=""
while [ "$#" -gt 0 ]; do
  case "$1" in https://*) url="$1" ;; -o) shift; target="$1" ;; esac
  shift
done
printf 'curl %s\\n' "$url" >> "$SSS_TEST_LOG"
[ "$SSS_TEST_DOWNLOAD_FAILURE" != 1 ] || exit 1
case "$url" in
  https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt) cp "$SSS_TEST_MANIFEST" "$target" ;;
  https://nodejs.org/dist/latest-v22.x/"$SSS_TEST_RELEASE".tar.gz) cp "$SSS_TEST_ARCHIVE" "$target" ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
  if (!missing.includes('jq')) fs.copyFileSync(jqSource, path.join(bin, 'jq'));
  if (!missing.includes('curl')) fs.copyFileSync(curlSource, path.join(bin, 'curl'));
  const installTools = `
printf '%s %s\\n' "$SSS_TEST_INSTALLER" "$*" >> "$SSS_TEST_LOG"
[ "$SSS_TEST_PACKAGE_FAILURE" != 1 ] || exit 1
if [ "$1" = install ]; then
  for tool in "$@"; do
    case "$tool" in
      jq) cp "$SSS_TEST_JQ_SOURCE" "$SSS_TEST_BIN/jq" ;;
      curl) cp "$SSS_TEST_CURL_SOURCE" "$SSS_TEST_BIN/curl" ;;
    esac
  done
fi`;
  script(platform === 'Darwin' ? 'brew' : 'apt-get', installTools);
  script('sudo', 'printf "sudo %s\\n" "$*" >> "$SSS_TEST_LOG"\nexec "$@"');
  const platformName = platform === 'Darwin' ? 'darwin' : 'linux';
  const arch = architecture === 'x86_64' ? 'x64' : 'arm64';
  const release = `node-v22.15.0-${platformName}-${arch}`;
  const extracted = path.join(directory, release, 'bin');
  fs.mkdirSync(extracted, { recursive: true });
  fs.writeFileSync(path.join(extracted, 'node'), '#!/bin/bash\necho v22.15.0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(extracted, 'npm'), '#!/bin/bash\necho 10.0.0\n', { mode: 0o755 });
  const archive = path.join(directory, 'node.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', directory, release]).status, 0);
  const checksum = checksumFailure ? '0'.repeat(64) : createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
  const manifest = path.join(directory, 'SHASUMS256.txt');
  fs.writeFileSync(manifest, `${checksum}  ${release}.tar.gz\n`);
  const settings = path.join(directory, 'nested', '.env');
  const env = { ...process.env, PATH: bin, HOME: home, SSS_ENV_FILE: settings,
    SSS_TEST_LOG: log, SSS_TEST_BIN: bin, SSS_TEST_JQ_SOURCE: jqSource, SSS_TEST_CURL_SOURCE: curlSource,
    SSS_TEST_MANIFEST: manifest, SSS_TEST_ARCHIVE: archive, SSS_TEST_RELEASE: release,
    SSS_TEST_INSTALLER: platform === 'Darwin' ? 'brew' : 'apt-get', SSS_TEST_DOWNLOAD_FAILURE: downloadFailure ? '1' : '',
  };
  return { directory, bin, home, settings, env, log, run: (args = ['init'], overrides = {}) => spawnSync('/bin/bash', [path.join(root, 'sss.sh'), ...args], {
    encoding: 'utf8', env: { ...env, ...overrides }, timeout: 10000,
  }), logs: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

for (const [platform, architecture] of [['Darwin', 'arm64'], ['Darwin', 'x86_64'], ['Linux', 'x86_64'], ['Linux', 'aarch64']]) {
  test(`init installs and reuses user Node/npm on ${platform}/${architecture}`, t => {
    const f = fixture(t, { platform, architecture });
    const first = f.run();
    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.equal(fs.statSync(f.settings).mode & 0o777, 0o600);
    const installed = path.join(f.home, '.local/share/sss/node/bin/node');
    assert.ok(fs.existsSync(installed));
    assert.equal(fs.readFileSync(path.join(f.bin, 'node'), 'utf8').includes('18.0.0'), true, 'system runtime is untouched');
    const logs = f.logs();
    assert.equal(logs.trim().split('\n').length, 2, 'only official checksum and archive are downloaded');
    const settings = fs.readFileSync(f.settings, 'utf8');
    const again = f.run();
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.equal(fs.readFileSync(f.settings, 'utf8'), settings);
    assert.equal(f.logs(), logs, 'ready dependencies are reused without downloading');
    const plan = f.run(['deploy', '--plan']);
    assert.equal(plan.status, 0, plan.stdout + plan.stderr);
  });
}

test('macOS init installs missing jq through Homebrew and reuses a suitable Node', t => {
  const f = fixture(t, { ready: true, missing: ['jq'] });
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(f.logs(), 'brew install jq\n');
  assert.equal(fs.existsSync(path.join(f.home, '.local/share/sss/node')), false);
});

test('Ubuntu/Debian init installs missing curl/jq through apt and then user Node', t => {
  const f = fixture(t, { platform: 'Linux', architecture: 'x86_64', missing: ['curl', 'jq'] });
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(f.logs(), /apt-get update/);
  assert.match(f.logs(), /apt-get install -y curl jq/);
  assert.equal(f.logs().split('\n').filter(line => line.startsWith('curl https:')).length, 2);
});

test('missing npm triggers a user runtime installation even when Node is suitable', t => {
  const f = fixture(t, { ready: true });
  fs.unlinkSync(path.join(f.bin, 'npm'));
  const result = f.run();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.existsSync(path.join(f.home, '.local/share/sss/node/bin/npm')));
});

for (const failure of ['checksumFailure', 'downloadFailure']) {
  test(`init ${failure} preserves old runtime and existing settings`, t => {
    const f = fixture(t, { [failure]: true });
    fs.mkdirSync(path.dirname(f.settings), { recursive: true });
    fs.writeFileSync(f.settings, '# existing private settings\n');
    const oldRuntime = path.join(f.home, '.local/share/sss/node');
    fs.mkdirSync(oldRuntime, { recursive: true });
    fs.writeFileSync(path.join(oldRuntime, 'keep'), 'previous-runtime');
    const result = f.run();
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(f.settings, 'utf8'), '# existing private settings\n');
    assert.equal(fs.readFileSync(path.join(oldRuntime, 'keep'), 'utf8'), 'previous-runtime');
    assert.deepEqual(fs.readdirSync(path.dirname(oldRuntime)), ['node'], 'staging files are cleaned');
  });
}

test('missing Homebrew gives actionable failure without generating settings or downloading', t => {
  const f = fixture(t, { missing: ['jq'] });
  fs.unlinkSync(path.join(f.bin, 'brew'));
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /需要 Homebrew/);
  assert.equal(fs.existsSync(f.settings), false);
  assert.equal(f.logs(), '');
});

test('package manager failure leaves existing settings unchanged', t => {
  const f = fixture(t, { ready: true, missing: ['jq'] });
  fs.mkdirSync(path.dirname(f.settings), { recursive: true });
  fs.writeFileSync(f.settings, 'SSS_WORKER_NAME=existing\n');
  const result = f.run(['init'], { SSS_TEST_PACKAGE_FAILURE: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(f.settings, 'utf8'), 'SSS_WORKER_NAME=existing\n');
  assert.equal(f.logs(), 'brew install jq\n');
});

test('help does not install or download dependencies', t => {
  const f = fixture(t, { missing: ['curl', 'jq'] });
  const result = f.run(['help']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /自动检查并安装/);
  assert.equal(f.logs(), '');
  assert.equal(fs.existsSync(f.settings), false);
});
