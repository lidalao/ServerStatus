const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const databaseId = '12345678-1234-1234-1234-123456789abc';
const recoveryId = '22345678-1234-1234-1234-123456789abc';
const base = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_API_TOKEN: 'cf-secret', GITHUB_RAW_URL: 'https://raw.githubusercontent.com/lidalao/ServerStatus/feature/cloudflare-monitor' };
const modulePromise = import('../scripts/deploy-cloudflare.mjs');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-deployment-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'node_modules/wrangler'), { recursive: true });
  const version = require('../package.json').devDependencies.wrangler;
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ devDependencies: { wrangler: version } }));
  fs.writeFileSync(path.join(directory, 'node_modules/wrangler/package.json'), JSON.stringify({ version }));
  return directory;
}

function harness(directory, overrides = {}) {
  const calls = [], commands = [], secrets = [], output = [];
  const options = {
    root: directory, settingsPath: path.join(directory, '.env'), settings: { ...base }, emit: text => output.push(text),
    api: async (route, method = 'GET', body) => {
      calls.push({ route, method, body });
      if (route === '/workers/scripts') return [];
      if (route === '/workers/subdomain') return { subdomain: 'test-account' };
      if (route.startsWith('/d1/database?')) return [];
      if (route === '/d1/database' && method === 'POST') return { uuid: body.name.startsWith('sss-recovery-') ? recoveryId : databaseId };
      if (route === `/d1/database/${recoveryId}/query`) return [{ success: true, results: [] }];
      if (route === `/d1/database/${databaseId}`) return { name: 'sss-server-status' };
      throw new Error('Unexpected API: ' + route);
    },
    run: async (command, args, options) => {
      commands.push({ command, args, options });
      const configPath = args[args.indexOf('--config') + 1];
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      assert.equal(config.assets.binding, 'ASSETS');
      assert.deepEqual(config.assets.run_worker_first, ['/api/*', '/json/*']);
      assert.equal(config.durable_objects.bindings[0].class_name, 'RealtimeHub');
      assert.deepEqual(config.migrations[0].new_sqlite_classes, ['RealtimeHub']);
      assert.equal(config.d1_databases.length, 1, 'the recovery database must never be bound to the public Worker');
      assert.match(config.vars.SSS_REALTIME_INTERVAL, /^(?:[1-9]|[1-5][0-9]|60)$/);
      assert.equal(config.triggers.crons[0], '* * * * *');
      assert.equal(config.account_id, base.CLOUDFLARE_ACCOUNT_ID);
      if (args.includes('--secrets-file')) {
        const file = args[args.indexOf('--secrets-file') + 1];
        assert.equal(fs.statSync(file).mode & 0o777, 0o600);
        secrets.push({ file, values: JSON.parse(fs.readFileSync(file, 'utf8')) });
      }
    },
    request: async () => new Response(JSON.stringify({ revision: 0, config: { servers: [] } }), { status: 200 }),
    ...overrides,
  };
  return { options, calls, commands, secrets, output };
}

test('initial deployment creates D1, persists credentials, migrates, publishes and removes secret files', async t => {
  const directory = fixture(t);
  const h = harness(directory);
  const { deploy } = await modulePromise;
  const config = await deploy(h.options);
  assert.equal(config.SSS_D1_ID, databaseId);
  assert.match(config.SSS_MANAGEMENT_TOKEN, /^[a-f0-9]{64}$/);
  assert.equal(config.SSS_WORKER_URL, 'https://sss-server-status.test-account.workers.dev');
  assert.equal(h.calls.filter(c => c.route === '/d1/database').length, 2);
  const backup = h.calls.find(c => c.body?.sql?.startsWith('INSERT INTO deployment_recovery'));
  const payload = JSON.parse(backup.body.params[0]);
  assert.equal(payload.config.SSS_MANAGEMENT_TOKEN, config.SSS_MANAGEMENT_TOKEN);
  assert.ok(!JSON.stringify(payload).includes('cf-secret'));
  assert.equal(payload.config.CLOUDFLARE_ACCOUNT_ID, undefined);
  assert.equal(h.commands.length, 3);
  assert.ok(h.commands[0].args.includes('--dry-run'));
  assert.deepEqual(h.commands[1].args.slice(1, 5), ['d1', 'migrations', 'apply', 'sss-server-status']);
  assert.equal(h.secrets[0].values.SSS_MANAGEMENT_TOKEN, config.SSS_MANAGEMENT_TOKEN);
  assert.equal(h.secrets[0].values.TG_BOT_TOKEN, '');
  assert.equal(fs.existsSync(h.secrets[0].file), false);
  assert.equal(fs.statSync(h.options.settingsPath).mode & 0o777, 0o600);
  const saved = fs.readFileSync(h.options.settingsPath, 'utf8');
  assert.ok(saved.includes(`SSS_D1_ID=${databaseId}`));
  assert.ok(saved.includes(`SSS_WORKER_URL=${config.SSS_WORKER_URL}`));
  assert.doesNotMatch(h.output.join('\n'), /cf-secret|local-online-pass/);
});

test('redeployment reuses D1 and management token and preserves env comments', async t => {
  const directory = fixture(t);
  const h = harness(directory, { settings: { ...base, SSS_D1_ID: databaseId, SSS_MANAGEMENT_TOKEN: 'stable-token',
    SSS_WORKER_URL: 'https://custom.example.com', TG_BOT_TOKEN: 'tg-secret', TG_CHAT_ID: '123' } });
  fs.writeFileSync(h.options.settingsPath, '# keep me\nCUSTOM_SETTING=kept\nSSS_D1_ID=old\nSSS_D1_ID=duplicate\n');
  const { deploy } = await modulePromise;
  const result = await deploy(h.options);
  assert.equal(result.SSS_MANAGEMENT_TOKEN, 'stable-token');
  assert.equal(result.SSS_WORKER_URL, 'https://custom.example.com');
  assert.equal(h.calls.some(c => c.route === '/d1/database' && c.body?.name === 'sss-server-status'), false);
  assert.equal(h.secrets[0].values.TG_BOT_TOKEN, 'tg-secret');
  const saved = fs.readFileSync(h.options.settingsPath, 'utf8');
  assert.match(saved, /# keep me\nCUSTOM_SETTING=kept/);
  assert.equal((saved.match(/SSS_D1_ID=/g) || []).length, 1);
});

test('deployment backup restores a second machine through the same D1 SQL without changing CF credentials', async t => {
  const directory = fixture(t);
  const h = harness(directory, { settings: { ...base, SSS_D1_ID: databaseId, SSS_MANAGEMENT_TOKEN: 'original-token',
    SSS_WORKER_URL: 'https://custom.example.com', SSS_REALTIME_INTERVAL: '2', TG_BOT_TOKEN: 'tg-original', TG_CHAT_ID: '123' } });
  const { deploy, recoverSettings, recoveryDatabaseName } = await modulePromise;
  const original = h.options.api;
  let created = false;
  const storage = path.join(directory, 'recovery.sqlite');
  const api = async (route, method, body) => {
    if (route.startsWith('/d1/database?name=sss-recovery-')) return created ? [{ name: recoveryDatabaseName('sss-server-status'), uuid: recoveryId }] : [];
    if (route === '/d1/database' && body?.name.startsWith('sss-recovery-')) { created = true; return { uuid: recoveryId }; }
    if (route === `/d1/database/${recoveryId}/query`) {
      const result = spawnSync('python3', ['-c', `import sqlite3,json,sys
request=json.load(sys.stdin)
db=sqlite3.connect(sys.argv[1]);db.row_factory=sqlite3.Row
cursor=db.execute(request['sql'],request['params'])
rows=[dict(row) for row in cursor.fetchall()] if cursor.description else []
db.commit();print(json.dumps(rows))`, storage], { input: JSON.stringify(body), encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return [{ success: true, results: JSON.parse(result.stdout) }];
    }
    if (route === '/workers/scripts') return [{ id: 'sss-server-status' }];
    return original(route, method, body);
  };
  h.options.api = api;
  const deployed = await deploy(h.options);
  const otherFile = path.join(directory, 'other.env');
  const recovered = await recoverSettings({ settingsPath: otherFile,
    settings: { CLOUDFLARE_ACCOUNT_ID: base.CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN: 'different-valid-token' }, api, emit() {} });
  for (const key of ['SSS_D1_ID', 'SSS_WORKER_URL', 'SSS_MANAGEMENT_TOKEN', 'TG_BOT_TOKEN', 'TG_CHAT_ID', 'SSS_REALTIME_INTERVAL']) assert.equal(recovered[key], deployed[key]);
  assert.equal(recovered.CLOUDFLARE_API_TOKEN, 'different-valid-token');
  assert.equal(fs.statSync(otherFile).mode & 0o777, 0o600);

  const changed = await deploy({ ...h.options, settingsPath: otherFile, settings: { ...recovered, SSS_REALTIME_INTERVAL: '3' } });
  assert.equal(changed.SSS_REALTIME_INTERVAL, '3');
  const updatedOriginal = await deploy({ ...h.options, settings: deployed });
  assert.equal(updatedOriginal.SSS_REALTIME_INTERVAL, '3', 'an unchanged local 2 must adopt remote 3');
  assert.match(fs.readFileSync(h.options.settingsPath, 'utf8'), /SSS_REALTIME_INTERVAL=3/);

  await deploy({ ...h.options, settingsPath: otherFile, settings: { ...changed, SSS_REALTIME_INTERVAL: '4' } });
  const beforeConflict = h.commands.length;
  await assert.rejects(deploy({ ...h.options, settings: { ...updatedOriginal, SSS_REALTIME_INTERVAL: '5' } }), /配置冲突.*SSS_REALTIME_INTERVAL/);
  assert.equal(h.commands.length, beforeConflict, 'conflicts stop before Worker deployment');
  const refreshed = await recoverSettings({ settingsPath: h.options.settingsPath, settings: updatedOriginal, api, emit() {} });
  assert.equal(refreshed.SSS_REALTIME_INTERVAL, '4', 'sync replaces stale and unpublished local settings');
  const other = await recoverSettings({ settingsPath: otherFile, settings: changed, api, emit() {} });
  await deploy({ ...h.options, settingsPath: otherFile, settings: { ...other, SSS_REALTIME_INTERVAL: '6' } });
  const merged = await deploy({ ...h.options, settings: { ...refreshed, TG_CHAT_ID: '456' } });
  assert.equal(merged.SSS_REALTIME_INTERVAL, '6', 'independent remote changes are adopted');
  assert.equal(merged.TG_CHAT_ID, '456', 'independent local changes are retained');

  await api(`/d1/database/${recoveryId}/query`, 'POST', { sql: 'UPDATE deployment_recovery SET lease_owner = ?, lease_until = ? WHERE id = 1', params: ['other-machine', Math.floor(Date.now()/1000)+900] });
  const beforeLocked = h.commands.length;
  await assert.rejects(deploy({ ...h.options, settings: merged }), /另一台机器正在部署/);
  assert.equal(h.commands.length, beforeLocked+1, 'only the read-only local dry run may run before acquiring the lock');
  const held = await api(`/d1/database/${recoveryId}/query`, 'POST', { sql: 'SELECT lease_owner FROM deployment_recovery WHERE id = 1', params: [] });
  assert.equal(held[0].results[0].lease_owner, 'other-machine', 'a failed contender cannot release another deploy lock');
  await api(`/d1/database/${recoveryId}/query`, 'POST', { sql: 'UPDATE deployment_recovery SET lease_until = ? WHERE id = 1', params: [Math.floor(Date.now()/1000)-1] });
  const afterCrash = await deploy({ ...h.options, settings: merged });
  assert.equal(afterCrash.SSS_REALTIME_INTERVAL, '6', 'an expired lock from a crashed deploy can be reclaimed');
});

test('backup failure distinguishes an already published service and preserves its local recovery credentials', async t => {
  const directory = fixture(t);
  const h = harness(directory);
  const original = h.options.api;
  h.options.api = async (route, ...args) => {
    if (route === `/d1/database/${recoveryId}/query`) throw Error('permission denied: cf-secret');
    return original(route, ...args);
  };
  const { deploy } = await modulePromise;
  await assert.rejects(deploy(h.options), error => /发布和验证已完成.*备份保存失败/.test(error.message) && !error.message.includes('cf-secret'));
  assert.match(fs.readFileSync(h.options.settingsPath, 'utf8'), /SSS_MANAGEMENT_TOKEN=[a-f0-9]{64}/);
  assert.equal(fs.existsSync(h.secrets[0].file), false);
});

test('existing named D1 is reused when its ID is not yet saved', async t => {
  const directory = fixture(t);
  const h = harness(directory);
  const original = h.options.api;
  h.options.api = async (route, ...args) => route.startsWith('/d1/database?') ? [{ name: 'sss-server-status', uuid: databaseId }] : original(route, ...args);
  const { deploy } = await modulePromise;
  await deploy(h.options);
  assert.equal(h.calls.some(c => c.route === '/d1/database' && c.body?.name === 'sss-server-status'), false);
});

test('plan makes no network calls, launches no commands and writes no settings', async t => {
  const directory = fixture(t);
  const h = harness(directory, { plan: true, settings: {} });
  const { deploy } = await modulePromise;
  await deploy(h.options);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.commands, []);
  assert.equal(fs.existsSync(h.options.settingsPath), false);
});

test('invalid deployment settings stop before creating remote resources', async t => {
  const directory = fixture(t);
  const { deploy } = await modulePromise;
  for (const settings of [{}, { ...base, SSS_WORKER_NAME: 'invalid name' }, { ...base, SSS_D1_ID: 'bad-id' }, { ...base, SSS_REALTIME_INTERVAL: '61' },
    { ...base, TG_BOT_TOKEN: 'only-token' }, { ...base, SSS_WORKER_URL: 'http://localhost' },
    { ...base, SSS_WORKER_URL: 'https://existing.example.com' }]) {
    const h = harness(directory, { settings });
    await assert.rejects(deploy(h.options));
    assert.equal(h.calls.length, 0);
    assert.equal(h.commands.length, 0);
  }
});

test('reporting interval accepts integer seconds 1–60 and rejects malformed values before deployment', async t => {
  const directory = fixture(t);
  const { deploy } = await modulePromise;
  for (const interval of ['1', '2', '5', '10', '59', '60']) {
    const h = harness(directory, { settings: { ...base, SSS_REALTIME_INTERVAL: interval } });
    const result = await deploy(h.options);
    assert.equal(result.SSS_REALTIME_INTERVAL, interval);
  }
  for (const interval of ['0', '-1', '61', '1.5', 'NaN', '5s', '1e1']) {
    const h = harness(directory, { settings: { ...base, SSS_REALTIME_INTERVAL: interval } });
    await assert.rejects(deploy(h.options), /SSS_REALTIME_INTERVAL/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.commands.length, 0);
  }
});

test('failed migration saves recovery credentials and D1 ID without deploying', async t => {
  const directory = fixture(t);
  const h = harness(directory);
  const original = h.options.run;
  h.options.run = async (...args) => {
    if (args[1].includes('migrations')) throw new Error('migration failed');
    return original(...args);
  };
  const { deploy } = await modulePromise;
  await assert.rejects(deploy(h.options), /migration failed/);
  assert.equal(h.secrets.length, 0);
  const saved = fs.readFileSync(h.options.settingsPath, 'utf8');
  assert.match(saved, /SSS_MANAGEMENT_TOKEN=[a-f0-9]{64}/);
  assert.ok(saved.includes(`SSS_D1_ID=${databaseId}`));
  assert.deepEqual(fs.readdirSync(path.join(directory, '.wrangler/deploy')), []);
});

test('failed publication removes staged secret files', async t => {
  const directory = fixture(t);
  const h = harness(directory);
  const original = h.options.run;
  h.options.run = async (...args) => {
    await original(...args);
    if (args[1].includes('--secrets-file')) throw new Error('deploy failed');
  };
  const { deploy } = await modulePromise;
  await assert.rejects(deploy(h.options), /deploy failed/);
  assert.equal(fs.existsSync(h.secrets[0].file), false);
});

test('CLI creates private unified settings without overwriting an existing file', t => {
  const directory = fixture(t);
  const filename = path.join(directory, '.env');
  const options = { encoding: 'utf8', env: { ...process.env, SSS_ENV_FILE: filename } };
  const result = spawnSync('bash', [path.join(root, 'sss.sh'), '--init'], options);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  const first = fs.readFileSync(filename, 'utf8');
  assert.match(first, /CLOUDFLARE_API_TOKEN=/);
  assert.equal(spawnSync('bash', [path.join(root, 'sss.sh'), '--init'], options).status, 0);
  assert.equal(fs.readFileSync(filename, 'utf8'), first);
});

test('CLI reads env data literally, respects overrides and does not execute shell payloads', t => {
  const directory = fixture(t);
  const filename = path.join(directory, '.env');
  const sentinel = path.join(directory, 'executed');
  fs.writeFileSync(filename, `SSS_WORKER_NAME="from-file"\r\nTG_CHAT_ID=\r\nUNKNOWN=$(touch ${sentinel})\r\nSSS_MANAGEMENT_TOKEN=$(touch ${sentinel})\r\n`);
  const result = spawnSync('bash', [path.join(root, 'sss.sh'), '--deploy', '--plan'], {
    encoding: 'utf8', env: { ...process.env, SSS_ENV_FILE: filename, SSS_WORKER_NAME: 'from-env' },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Worker=from-env/);
  assert.equal(fs.existsSync(sentinel), false);
  assert.equal(fs.readFileSync(filename, 'utf8').includes('$(touch'), true);
});

test('published-but-unreachable Worker reports failure and preserves its URL for recovery', async t => {
  const directory = fixture(t);
  const h = harness(directory, { request: async () => new Response('{}', { status: 503 }), sleep: async () => {} });
  const { deploy } = await modulePromise;
  await assert.rejects(deploy(h.options), /管理 API 验证失败/);
  assert.equal(h.secrets.length, 1);
  assert.equal(fs.existsSync(h.secrets[0].file), false);
  assert.match(fs.readFileSync(h.options.settingsPath, 'utf8'), /SSS_WORKER_URL=https:/);
});

test('generated production config compiles with the pinned Wrangler without remote operations', async t => {
  const directory = fixture(t);
  const h = harness(directory);
  h.options.root = root;
  h.options.run = async (command, args, options) => {
    if (!args.includes('--dry-run')) return;
    const result = spawnSync(command, args, { ...options, encoding: 'utf8',
      env: { ...options.env, WRANGLER_LOG_PATH: path.join(directory, 'wrangler.log') } });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Read 10 files/);
  };
  const { deploy } = await modulePromise;
  await deploy(h.options);
});

test('existing Worker cannot have its management token replaced implicitly', async t => {
  const directory = fixture(t);
  const h = harness(directory);
  const original = h.options.api;
  h.options.api = async (route, ...args) => route === '/workers/scripts' ? [{ id: 'sss-server-status' }] : original(route, ...args);
  const { deploy } = await modulePromise;
  await assert.rejects(deploy(h.options), /请填写原 SSS_MANAGEMENT_TOKEN/);
  assert.equal(h.calls.some(c => c.method === 'POST'), false);
  assert.equal(fs.existsSync(h.options.settingsPath), false);
});

test('configured database mismatch fails without recreating or deploying', async t => {
  const directory = fixture(t);
  const h = harness(directory, { settings: { ...base, SSS_D1_ID: databaseId, SSS_MANAGEMENT_TOKEN: 'stable' } });
  const original = h.options.api;
  h.options.api = async (route, ...args) => route === `/d1/database/${databaseId}` ? { name: 'wrong-database' } : original(route, ...args);
  const { deploy } = await modulePromise;
  await assert.rejects(deploy(h.options), /不匹配/);
  assert.equal(h.calls.some(c => c.method === 'POST'), false);
  assert.equal(h.secrets.length, 0);
});

test('standalone CLI downloads its configured source and passes the same settings file to deployment', t => {
  const directory = fixture(t);
  const standalone = path.join(directory, 'sss.sh');
  fs.copyFileSync(path.join(root, 'sss.sh'), standalone);
  const contents = path.join(directory, 'archive/source/scripts');
  fs.mkdirSync(contents, { recursive: true });
  fs.writeFileSync(path.join(contents, 'deploy-cloudflare.mjs'), `import fs from 'node:fs'; fs.writeFileSync(process.env.SSS_TEST_RESULT, JSON.stringify(process.argv.slice(2)));`);
  const archive = path.join(directory, 'source.tar.gz');
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', path.join(directory, 'archive'), 'source']).status, 0);
  const binary = path.join(directory, 'bin');
  fs.mkdirSync(binary);
  const downloadLog = path.join(directory, 'download.log');
  fs.writeFileSync(path.join(binary, 'curl'), '#!/bin/sh\nprintf "%s\\n%s\\n" "$4" "$6" > "$SSS_TEST_DOWNLOAD_LOG"\ncp "$SSS_TEST_ARCHIVE" "$6"\n', { mode: 0o755 });
  const settingsPath = path.join(directory, '.env');
  fs.writeFileSync(settingsPath, `CLOUDFLARE_ACCOUNT_ID=${base.CLOUDFLARE_ACCOUNT_ID}\nCLOUDFLARE_API_TOKEN=${base.CLOUDFLARE_API_TOKEN}\nGITHUB_RAW_URL=${base.GITHUB_RAW_URL}\n`);
  const resultPath = path.join(directory, 'result.json');
  const result = spawnSync('bash', [standalone, '--deploy'], { encoding: 'utf8',
    env: { ...process.env, SSS_ENV_FILE: settingsPath, PATH: `${binary}:${process.env.PATH}`,
      SSS_TEST_DOWNLOAD_LOG: downloadLog, SSS_TEST_ARCHIVE: archive, SSS_TEST_RESULT: resultPath } });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(resultPath)), ['--settings', settingsPath]);
  const [downloadUrl, stagedArchive] = fs.readFileSync(downloadLog, 'utf8').trim().split('\n');
  assert.equal(downloadUrl, 'https://codeload.github.com/lidalao/ServerStatus/tar.gz/feature/cloudflare-monitor');
  assert.equal(fs.existsSync(path.dirname(stagedArchive)), false, 'temporary source is cleaned after deployment');
});

test('missing CF configuration stops standalone deployment before downloading source', t => {
  const directory = fixture(t);
  const standalone = path.join(directory, 'sss.sh');
  fs.copyFileSync(path.join(root, 'sss.sh'), standalone);
  const result = spawnSync('bash', [standalone, '--deploy'], { encoding: 'utf8',
    env: { ...process.env, SSS_ENV_FILE: path.join(directory, 'missing.env'), CLOUDFLARE_ACCOUNT_ID: '', CLOUDFLARE_API_TOKEN: '', XDG_CONFIG_HOME: directory } });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /填写 CLOUDFLARE_ACCOUNT_ID 和 CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(result.stdout, /正在下载/);
});

test('Bash update requires an existing deployment and keeps CF actions outside the node menu', t => {
  const directory = fixture(t);
  const result = spawnSync('bash', [path.join(root, 'sss.sh'), 'update', '--plan'], {
    encoding: 'utf8', env: { ...process.env, SSS_ENV_FILE: path.join(directory, 'missing.env'),
      SSS_D1_ID: '', SSS_WORKER_URL: '', SSS_MANAGEMENT_TOKEN: '', XDG_CONFIG_HOME: directory },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /首次部署/);
  const help = spawnSync('bash', [path.join(root, 'sss.sh'), 'help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /init.*deploy.*update/);
  assert.match(help.stdout, /只进入节点管理菜单/);
});


test('npm deploy uses the unified CLI settings and plan remains offline', t => {
  const directory = fixture(t);
  const filename = path.join(directory, '.env');
  fs.writeFileSync(filename, 'SSS_WORKER_NAME=npm-target\n');
  const result = spawnSync('npm', ['run', 'deploy', '--', '--plan'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, SSS_ENV_FILE: filename },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Worker=npm-target/);
  assert.equal(fs.readFileSync(filename, 'utf8'), 'SSS_WORKER_NAME=npm-target\n');
});

test('saved settings replace BOM-prefixed keys instead of retaining stale credentials', async t => {
  const directory = fixture(t);
  const filename = path.join(directory, '.env');
  fs.writeFileSync(filename, '\uFEFFSSS_WORKER_NAME=old-name\r\n');
  const { saveSettings } = await modulePromise;
  saveSettings(filename, { SSS_WORKER_NAME: 'new-name' });
  const result = spawnSync('bash', [path.join(root, 'sss.sh'), 'deploy', '--plan'], {
    encoding: 'utf8', env: { ...process.env, SSS_ENV_FILE: filename },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Worker=new-name/);
  assert.doesNotMatch(fs.readFileSync(filename, 'utf8'), /old-name/);
});

test('workers.dev address mismatch stops before changing remote resources', async t => {
  const directory = fixture(t);
  const h = harness(directory, { settings: { ...base, SSS_MANAGEMENT_TOKEN: 'stable', SSS_WORKER_URL: 'https://old.other-account.workers.dev' } });
  const { deploy } = await modulePromise;
  await assert.rejects(deploy(h.options), /Worker 名称或 CF 账号不匹配/);
  assert.equal(h.calls.some(c => c.method === 'POST'), false);
  assert.equal(h.secrets.length, 0);
});

test('healthy custom domain cannot mask an unreachable newly deployed Worker', async t => {
  const directory = fixture(t);
  const requested = [];
  const h = harness(directory, { settings: { ...base, SSS_MANAGEMENT_TOKEN: 'stable', SSS_WORKER_URL: 'https://custom.example.com' },
    request: async url => {
      requested.push(url);
      return new Response(JSON.stringify({ revision: 0, config: { servers: [] } }), {
        status: url.includes('workers.dev') ? 503 : 200,
      });
    }, sleep: async () => {} });
  const { deploy } = await modulePromise;
  await assert.rejects(deploy(h.options), /管理 API 验证失败/);
  assert.ok(requested.length && requested.every(url => url.includes('workers.dev')));
});
