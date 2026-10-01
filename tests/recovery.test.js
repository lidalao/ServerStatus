const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const modulePromise = import('../scripts/deploy-cloudflare.mjs');
const root = path.resolve(__dirname, '..');
const db = '12345678-1234-1234-1234-123456789abc';
const recovery = '22345678-1234-1234-1234-123456789abc';
const settings = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'this-machine-token' };
const remote = { SSS_WORKER_NAME: 'sss-server-status', SSS_D1_NAME: 'existing-db', SSS_D1_ID: db,
  SSS_WORKER_URL: 'https://status.example.com', SSS_MANAGEMENT_TOKEN: 'original-management-secret',
  TG_BOT_TOKEN: 'telegram-secret', TG_CHAT_ID: '123', SSS_REALTIME_INTERVAL: '2',
  GITHUB_RAW_URL: 'https://raw.githubusercontent.com/lidalao/ServerStatus/feature/cloudflare-monitor' };
async function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-recovery-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, `# preserved\nCLOUDFLARE_ACCOUNT_ID=${settings.CLOUDFLARE_ACCOUNT_ID}\nCLOUDFLARE_API_TOKEN=${settings.CLOUDFLARE_API_TOKEN}\nCUSTOM_SETTING=keep\n`);
  const original = fs.readFileSync(file, 'utf8');
  const calls = [], output = [];
  const { recoverSettings, recoveryDatabaseName } = await modulePromise;
  const name = recoveryDatabaseName('sss-server-status');
  const options = { settingsPath: file, settings, emit: value => output.push(value), api: async (route, method = 'GET', body) => {
    calls.push({ route, method, body });
    if (route.startsWith('/d1/database?')) return [{ name, uuid: recovery }];
    if (route === `/d1/database/${recovery}/query`) {
      assert.equal(body.sql, 'SELECT payload FROM deployment_recovery WHERE id = 1', 'recovery must only read remote data');
      return [{ success: true, results: [{ payload: JSON.stringify({ version: 1, config: remote }) }] }];
    }
    if (route === `/d1/database/${db}`) return { name: remote.SSS_D1_NAME };
    if (route === '/workers/scripts') return [{ id: 'sss-server-status' }];
    throw Error('Unexpected API call');
  }, ...overrides };
  return { recoverSettings, options, file, original, calls, output };
}

test('two CF credentials restore existing deployment, TG and interval without rotating credentials', async t => {
  const f = await fixture(t);
  const result = await f.recoverSettings(f.options);
  for (const [key, value] of Object.entries(remote)) assert.equal(result[key], value);
  assert.equal(result.CLOUDFLARE_API_TOKEN, settings.CLOUDFLARE_API_TOKEN);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  const content = fs.readFileSync(f.file, 'utf8');
  assert.match(content, /# preserved/); assert.match(content, /CUSTOM_SETTING=keep/);
  assert.match(content, /SSS_REALTIME_INTERVAL=2/);
  for (const secret of [settings.CLOUDFLARE_API_TOKEN, remote.SSS_MANAGEMENT_TOKEN, remote.TG_BOT_TOKEN]) assert.ok(!f.output.join('\n').includes(secret));
  assert.ok(!f.calls.some(call => /INSERT|UPDATE|DELETE|CREATE/.test(call.body?.sql || '')));
});

test('a backup cannot override this machine CF credentials or inject unknown env settings', async t => {
  const f = await fixture(t);
  const original = f.options.api;
  f.options.api = async (route, ...args) => route.endsWith('/query') ? [{ success: true, results: [{ payload: JSON.stringify({ version: 1, config: { ...remote,
    CLOUDFLARE_API_TOKEN: 'untrusted', CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32), NODE_OPTIONS: '--require evil' } }) }] }] : original(route, ...args);
  const result = await f.recoverSettings(f.options);
  assert.equal(result.CLOUDFLARE_API_TOKEN, settings.CLOUDFLARE_API_TOKEN);
  assert.equal(result.CLOUDFLARE_ACCOUNT_ID, settings.CLOUDFLARE_ACCOUNT_ID);
  assert.doesNotMatch(fs.readFileSync(f.file, 'utf8'), /NODE_OPTIONS|untrusted/);
});

test('old deployment without backup fails without regenerating tokens or writing local env', async t => {
  const f = await fixture(t);
  f.options.api = async route => route.startsWith('/d1/database?') ? [] : [{ id: 'sss-server-status' }];
  await assert.rejects(f.recoverSettings(f.options), /原管理机器.*update/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
});

test('a genuinely new account stays ready for first deploy without creating remote resources', async t => {
  const f = await fixture(t, { api: async () => [] });
  assert.equal(await f.recoverSettings(f.options), null);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
});

test('malformed, multiline, missing and mismatched backups leave local settings untouched', async t => {
  for (const payload of ['bad-json', JSON.stringify({ version: 2, config: remote }),
    JSON.stringify({ version: 1, config: { ...remote, SSS_MANAGEMENT_TOKEN: 'secret\nINJECTED=1' } }),
    JSON.stringify({ version: 1, config: { ...remote, SSS_WORKER_NAME: 'other-worker' } }),
    JSON.stringify({ version: 1, config: { ...remote, SSS_MANAGEMENT_TOKEN: '' } })]) {
    const f = await fixture(t);
    const original = f.options.api;
    f.options.api = async (route, ...args) => route.endsWith('/query') ? [{ success: true, results: [{ payload }] }] : original(route, ...args);
    await assert.rejects(f.recoverSettings(f.options), /恢复备份/);
    assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
  }
});

test('revoked API token produces a sanitized error without exposing API response secrets', async t => {
  const f = await fixture(t);
  delete f.options.api;
  f.options.request = async () => new Response(JSON.stringify({ success: false, errors: [{ message: 'this-machine-token telegram-secret' }] }), { status: 403 });
  await assert.rejects(f.recoverSettings(f.options), error => /403/.test(error.message) && !/this-machine-token|telegram-secret/.test(error.message));
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
});

test('a deleted or wrong-account target cannot be restored from an obsolete backup', async t => {
  const f = await fixture(t);
  const original = f.options.api;
  f.options.api = async (route, ...args) => route === `/d1/database/${db}` ? { name: 'wrong-db' } : original(route, ...args);
  await assert.rejects(f.recoverSettings(f.options), /不匹配/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), f.original);
});

test('init with two CF credentials invokes read-only recovery; complete config skips recovery', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-init-recover-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'scripts'));fs.copyFileSync(path.join(root, 'sss.sh'), path.join(dir, 'sss.sh'));
  const marker = path.join(dir, 'called');
  fs.writeFileSync(path.join(dir, 'scripts/deploy-cloudflare.mjs'), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify(process.argv.slice(2)));`);
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, `CLOUDFLARE_ACCOUNT_ID=${settings.CLOUDFLARE_ACCOUNT_ID}\nCLOUDFLARE_API_TOKEN=${settings.CLOUDFLARE_API_TOKEN}\n`);
  const options = { encoding: 'utf8', env: { ...process.env, SSS_ENV_FILE: file, SSS_D1_ID: '', SSS_WORKER_URL: '', SSS_MANAGEMENT_TOKEN: '' } };
  const result = spawnSync('bash', [path.join(dir, 'sss.sh'), 'init'], options);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker)), ['--settings', file, '--recover']);
  fs.rmSync(marker);
  fs.appendFileSync(file, `SSS_D1_ID=${db}\nSSS_WORKER_URL=${remote.SSS_WORKER_URL}\nSSS_MANAGEMENT_TOKEN=${remote.SSS_MANAGEMENT_TOKEN}\n`);
  const complete = fs.readFileSync(file, 'utf8');
  assert.equal(spawnSync('bash', [path.join(dir, 'sss.sh'), 'init'], options).status, 0);
  assert.equal(fs.existsSync(marker), false);
  assert.equal(fs.readFileSync(file, 'utf8'), complete);
  const sync = spawnSync('bash', [path.join(dir, 'sss.sh'), 'sync'], options);
  assert.equal(sync.status, 0, sync.stdout + sync.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker)), ['--settings', file, '--recover']);
});
