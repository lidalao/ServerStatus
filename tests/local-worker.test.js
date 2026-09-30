const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { after, before, test } = require('node:test');
const { visibleServers } = require('../service/web/js/visibility.js');

const root = path.resolve(__dirname, '..');
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const stateDir = path.join(root, '.wrangler/test-state');
const logFile = path.join(stateDir, 'wrangler.log');
const token = 'local-test-token';
let worker;
let baseUrl;
let workerOutput = '';
let headers;

function runWrangler(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    cwd: root,
    encoding: 'utf8',
    input: 'y\n',
    env: { ...process.env, WRANGLER_LOG_PATH: logFile, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false' },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function putConfig(revision, config) {
  return fetch(`${baseUrl}/api/admin/config`, {
    method: 'PUT', headers,
    body: JSON.stringify({ revision, config }),
  });
}

function runCli(input, overrides = {}) {
  const standaloneScript = path.join(stateDir, 'standalone-sss.sh');
  if (!fs.existsSync(standaloneScript)) fs.copyFileSync(path.join(root, 'sss.sh'), standaloneScript);
  return spawnSync('bash', [standaloneScript], {
    cwd: stateDir,
    encoding: 'utf8',
    input,
    env: { ...process.env, SSS_WORKER_URL: baseUrl, SSS_MANAGEMENT_TOKEN: token, TERM: 'dumb', ...overrides },
    timeout: 10000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

async function remoteConfig() {
  const response = await fetch(`${baseUrl}/api/admin/config`, { headers });
  assert.equal(response.status, 200);
  return response.json();
}

function assertHiddenOnPhoneButNetworkVisible(css) {
  const phoneRules = css.match(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(phoneRules, 'phone breakpoint at 640px exists');
  assert.match(phoneRules[1], /#grid\s+th:nth-child\(2\)[\s\S]*?#grid\s+td:nth-child\(2\)[\s\S]*?display:\s*none/,
    'PROTO header and cells are hidden on phones');
  assert.doesNotMatch(phoneRules[1], /nth-child\(8\)/,
    'NETWORK header and cells remain visible on phones');
  const html = fs.readFileSync(path.join(root, 'service/web/index.html'), 'utf8');
  const headersInOrder = [...html.matchAll(/<th\b[^>]*>([^<]+)<\/th>/g)].map((match) => match[1].trim());
  assert.equal(headersInOrder[1], 'PROTO');
  assert.equal(headersInOrder[7], 'NETWORK');
}

before(async () => {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.mkdirSync(stateDir, { recursive: true });
  runWrangler([
    'd1', 'migrations', 'apply', 'sss-server-status-local', '--local',
    '--config', 'wrangler.local.toml', '--persist-to', '.wrangler/test-state',
  ]);

  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  worker = spawn(process.execPath, [
    wrangler, 'dev', '--config', 'wrangler.local.toml', '--ip', '127.0.0.1',
    '--port', String(port), '--persist-to', '.wrangler/test-state', '--log-level', 'error',
  ], {
    cwd: root,
    env: { ...process.env, WRANGLER_LOG_PATH: logFile, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false', CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stdout.on('data', (data) => { workerOutput += data.toString(); });
  worker.stderr.on('data', (data) => { workerOutput += data.toString(); });

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (worker.exitCode !== null) break;
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) { ready = true; break; }
    } catch (_) { /* Wrangler is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, `Local Worker did not start.\n${workerOutput}`);
  headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
});

after(async () => {
  if (worker && worker.exitCode === null) {
    worker.kill('SIGTERM');
    await Promise.race([once(worker, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

test('local Cloudflare Worker and dashboard acceptance cases', async (t) => {
  await t.test('health check and initialized configuration', async () => {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    assert.match(health.headers.get('cache-control'), /no-store/);

    const initial = await fetch(`${baseUrl}/api/admin/config`, { headers });
    assert.equal(initial.status, 200);
    const body = await initial.json();
    assert.equal(body.revision, 0);
    assert.deepEqual(body.config.servers, []);
  });

  await t.test('admin API rejects missing or wrong credentials and unsupported methods', async () => {
    assert.equal((await fetch(`${baseUrl}/api/admin/config`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/admin/config`, { headers: { authorization: 'Bearer wrong' } })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/admin/config`, { method: 'POST', headers })).status, 405);
  });

  const config = {
    servers: [
      { name: 'visible-online', username: 'visible-user', password: 'visible-pass', host: 'vps-a', type: 'kvm', location: 'US', monthstart: '1' },
      { name: 'hidden-offline', username: 'hidden-user', password: 'hidden-pass', host: 'vps-b', type: 'kvm', location: 'JP', monthstart: '1', hidden: true },
      { name: 'visible-offline', username: 'offline-user', password: 'offline-pass', host: 'vps-c', type: 'kvm', location: 'SG', monthstart: '1', hidden: false },
      { name: 'hidden-online', username: 'hidden-online-user', password: 'hidden-online-pass', host: 'vps-d', type: 'kvm', location: 'DE', monthstart: '1', hidden: true },
    ],
  };

  await t.test('admin config validates JSON, size, schema, uniqueness, and revision', async () => {
    const malformed = await fetch(`${baseUrl}/api/admin/config`, { method: 'PUT', headers, body: '{' });
    assert.equal(malformed.status, 400);
    for (const revision of ['not-a-revision', '0', null, false]) assert.equal((await putConfig(revision, config)).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/admin/config`, { method: 'PUT', headers, body: 'null' })).status, 400);
    for (const invalid of [
      { servers: 'not-an-array' },
      { servers: [{ name: 'node', username: 'u', password: 'p', hidden: 'yes' }] },
      { servers: [{ name: 'node', username: 'u' }] },
      { servers: [{ name: 'dup', username: 'u1', password: 'p' }, { name: 'dup', username: 'u2', password: 'p' }] },
      { servers: [{ name: 'n1', username: 'dup', password: 'p' }, { name: 'n2', username: 'dup', password: 'p' }] },
      { servers: Array.from({ length: 501 }, (_, i) => ({ name: `n${i}`, username: `u${i}`, password: 'p' })) },
    ]) assert.equal((await putConfig(0, invalid)).status, 400);

    const oversized = await fetch(`${baseUrl}/api/admin/config`, {
      method: 'PUT', headers,
      body: JSON.stringify({ revision: 0, config: { servers: [], padding: 'x'.repeat(270_000) } }),
    });
    assert.equal(oversized.status, 413);

    const saved = await putConfig(0, config);
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).revision, 1);
    const stale = await putConfig(0, config);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).revision, 1);
  });

  await t.test('CLI rejects invalid edits and exits cleanly on EOF without submitting', async () => {
    const before = await remoteConfig();
    for (const input of ['', '2\nvisible-online\n', '2\nunfinished\n', '4\n0\n\n\n\n32\n']) {
      const result = runCli(input);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /输入已结束/);
    }
    assert.deepEqual(await remoteConfig(), before);
  });

  await t.test('management API rejects invalid metadata and monthstart without changing config', async () => {
    const before = await remoteConfig();
    for (const change of [{ monthstart: 0 }, { monthstart: 32 }, { monthstart: [1] }, { location: {} }, { type: false }]) {
      const config = structuredClone(before.config);
      Object.assign(config.servers[0], change);
      assert.equal((await putConfig(before.revision, config)).status, 400);
    }
    assert.deepEqual(await remoteConfig(), before);
  });

  await t.test('agent report rejects invalid input and credentials without exposing metrics', async () => {
    const method = await fetch(`${baseUrl}/api/agent/report`, { method: 'GET' });
    assert.equal(method.status, 405);
    assert.equal((await fetch(`${baseUrl}/api/agent/report`, { method: 'POST', headers, body: '{' })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/agent/report`, { method: 'POST', headers, body: JSON.stringify({ username: 'x' }) })).status, 400);
    assert.equal((await fetch(`${baseUrl}/api/agent/report`, {
      method: 'POST', headers, body: JSON.stringify({ username: 'visible-user', password: 'wrong', metrics: {} }),
    })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/agent/report`, {
      method: 'POST', headers, body: JSON.stringify({ username: 'missing-user', password: 'p', metrics: {} }),
    })).status, 401);
    assert.equal((await fetch(`${baseUrl}/api/agent/report`, {
      method: 'POST', headers, body: JSON.stringify({ username: 'visible-user', password: 'visible-pass', metrics: { padding: 'x'.repeat(34_000) } }),
    })).status, 413);

    for (const metrics of [[], { online4: 'false', network_in: 0, network_out: 0 },
      { cpu: {}, network_in: 0, network_out: 0 }, { network_in: -1, network_out: 0 },
      { network_in: 0 }, { network_in: 0, network_out: 0, cpu: 'NaN' }]) {
      assert.equal((await fetch(`${baseUrl}/api/agent/report`, {
        method: 'POST', headers, body: JSON.stringify({ username: 'visible-user', password: 'visible-pass', metrics }),
      })).status, 400);
    }
    const valid = await fetch(`${baseUrl}/api/agent/report`, {
      method: 'POST', headers,
      body: JSON.stringify({ username: 'visible-user', password: 'visible-pass', metrics: {
        online4: true, network_in: 100, network_out: 200, cpu: 4, password: 'must-not-leak', unexpected: 'discard-me',
      } }),
    });
    assert.equal(valid.status, 200);
    assert.equal((await valid.json()).ok, true);
    const hiddenReport = await fetch(`${baseUrl}/api/agent/report`, {
      method: 'POST', headers,
      body: JSON.stringify({ username: 'hidden-online-user', password: 'hidden-online-pass', metrics: { online4: true, network_in: 123, network_out: 456 } }),
    });
    assert.equal(hiddenReport.status, 200, 'hidden nodes continue reporting to the backend');
  });

  await t.test('stats retain hidden nodes for management/notifications but strip secrets and filter only in UI', async () => {
    const response = await fetch(`${baseUrl}/json/stats.json`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const stats = await response.json();
    assert.equal(stats.servers.length, 4);
    const hidden = stats.servers.find((server) => server.name === 'hidden-offline');
    const hiddenOnline = stats.servers.find((server) => server.name === 'hidden-online');
    const visible = stats.servers.find((server) => server.name === 'visible-online');
    assert.equal(hidden.hidden, true);
    assert.equal(hidden.online4, false, 'hidden node can remain offline');
    assert.equal(hiddenOnline.online4, true, 'hidden node continues reporting and is monitored');
    assert.equal(visible.online4, true);
    assert.equal(visible.cpu, 4);
    for (const node of stats.servers) assert.equal('password' in node, false);
    assert.equal('unexpected' in visible, false, 'unsupported agent fields are discarded');
    assert.deepEqual(visibleServers(stats.servers).map((server) => server.name), ['visible-online', 'visible-offline']);
    assert.deepEqual(visibleServers([hidden, hiddenOnline]).map((server) => server.name), [], 'both offline and online hidden nodes stay absent');
    assert.deepEqual(visibleServers([null, undefined, { name: 'legacy-node' }]).map((server) => server.name), ['legacy-node']);
  });

  await t.test('standalone sss.sh explains missing or mismatched Worker credentials', async () => {
    const emptyConfig = path.join(stateDir, 'no-user-config');
    const missing = runCli('', {
      SSS_WORKER_URL: '', SSS_MANAGEMENT_TOKEN: '', XDG_CONFIG_HOME: emptyConfig,
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stdout, /尚未配置 Cloudflare Worker 管理参数/);
    assert.doesNotMatch(missing.stdout, /必须使用 root|缺少 docker/i);

    const mismatched = runCli('', {
      SSS_MANAGEMENT_TOKEN: 'different-token', XDG_CONFIG_HOME: emptyConfig,
    });
    assert.notEqual(mismatched.status, 0);
    assert.match(mismatched.stdout, /无法读取 Worker 配置/);
  });

  await t.test('management reads a unified env file without CF deployment credentials', async () => {
    const filename = path.join(stateDir, 'manager config.env');
    fs.writeFileSync(filename, `SSS_WORKER_URL="${baseUrl}"\r\nSSS_MANAGEMENT_TOKEN='${token}'\r\nGITHUB_RAW_URL=https://raw.githubusercontent.com/lidalao/ServerStatus/test-release\r\n`, { mode: 0o600 });
    const result = runCli('1\n\n\n0\n', { SSS_ENV_FILE: filename, SSS_WORKER_URL: '', SSS_MANAGEMENT_TOKEN: '' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /visible-online/);
    assert.match(result.stdout, /GITHUB_RAW_URL=https:\/\/raw.githubusercontent.com\/lidalao\/ServerStatus\/test-release bash/);
    assert.doesNotMatch(result.stdout, /请.*CLOUDFLARE_API_TOKEN/);
  });

  await t.test('local CLI hide toggle submits to D1 and preserves node management workflow', async () => {
    const cli = runCli('5\n1\n\n0\n');
    assert.equal(cli.status, 0, `${cli.stdout}\n${cli.stderr}`);
    const afterCli = await fetch(`${baseUrl}/api/admin/config`, { headers });
    const managedConfig = await afterCli.json();
    assert.equal(managedConfig.revision, 2);
    assert.equal(managedConfig.config.servers[1].hidden, false, `CLI toggle is saved remotely.\n${cli.stdout}\n${cli.stderr}`);
  });

  await t.test('standalone sss.sh can add, view, update, and delete Worker nodes', async () => {
    const add = runCli('2\ncli-added\nZZ\nkvm\n\n0\n');
    assert.equal(add.status, 0, `${add.stdout}\n${add.stderr}`);
    assert.doesNotMatch(add.stdout, /部署\/更新 CF Web/);
    assert.match(add.stdout, /curl -fsSL https:\/\/raw\.githubusercontent\.com\/lidalao\/ServerStatus\/feature\/cloudflare-monitor\/agent\/sss-agent\.sh/, 'new node prints the GitHub-hosted Agent installer command');
    assert.doesNotMatch(add.stdout, /sudo \.\/sss-agent\.sh/, 'Agent setup is user-scoped and does not ask for root');
    let result = await remoteConfig();
    assert.equal(result.revision, 3);
    let node = result.config.servers.find((server) => server.name === 'cli-added');
    assert.ok(node, 'new node is automatically submitted from a standalone copy');
    assert.ok(add.stdout.indexOf('已提交到 Cloudflare') < add.stdout.indexOf('添加成功'), 'success follows remote confirmation');
    assert.ok(add.stdout.indexOf('已提交到 Cloudflare') < add.stdout.indexOf('curl -fsSL'), 'installation command follows remote confirmation');
    assert.doesNotMatch(add.stdout.replace(/\x1b\[[0-9;]*m/g, ''), /6\. 提交到 Cloudflare|使用菜单 6/);
    assert.equal(node.location, 'ZZ');
    assert.equal(node.host, 'cli-added');
    assert.ok(node.username && node.password, 'CLI generates credentials required by its Agent');
    const username = node.username;

    let index = result.config.servers.findIndex((server) => server.name === 'cli-added');
    const update = runCli(`4\n${index}\ncli-updated\nCA\n\n5\n\n0\n`);
    assert.equal(update.status, 0, `${update.stdout}\n${update.stderr}`);
    result = await remoteConfig();
    assert.equal(result.revision, 4);
    node = result.config.servers.find((server) => server.name === 'cli-updated');
    assert.ok(node, 'rename is committed to the Worker');
    assert.equal(node.location, 'CA');
    assert.equal(node.type, 'kvm');
    assert.equal(node.monthstart, '5');
    assert.equal(node.username, username, 'node credentials remain stable across metadata updates');

    index = result.config.servers.findIndex((server) => server.name === 'cli-updated');
    const view = runCli(`1\n${index}\n\n0\n`);
    assert.equal(view.status, 0, `${view.stdout}\n${view.stderr}`);
    assert.match(view.stdout, /cli-updated/);
    assert.equal((await remoteConfig()).revision, result.revision, 'view does not submit configuration');
    assert.match(view.stdout, /curl -fsSL https:\/\/raw\.githubusercontent\.com\/lidalao\/ServerStatus\/feature\/cloudflare-monitor\/agent\/sss-agent\.sh/, 'view command can recover/reprint the GitHub-hosted Agent setup instruction');

    const remove = runCli(`3\n${index}\ny\n\n0\n`);
    assert.equal(remove.status, 0, `${remove.stdout}\n${remove.stderr}`);
    result = await remoteConfig();
    assert.equal(result.revision, 5);
    assert.equal(result.config.servers.some((server) => server.username === username), false, 'delete is committed to D1');
  });

  await t.test('automatic node submission failures reconcile remote state without printing installation commands', async () => {
    const fakeBin = path.join(stateDir, 'submit-curl-bin');
    fs.mkdirSync(fakeBin);
    const realCurl = spawnSync('which', ['curl'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(fakeBin, 'curl'), `#!/bin/bash
args=("$@")
put=false
for arg in "$@"; do [ "$arg" != PUT ] || put=true; done
if $put; then
  case "$SSS_TEST_SUBMIT_MODE" in
    rejected) printf '%s' '{"error":"Unauthorized"}'; exit 0 ;;
    network) exit 28 ;;
    conflict)
      for ((i=0;i<$#;i++)); do
        if [ "\${args[$i]}" = --data-binary ]; then
          j=$((i+1)); args[$j]=$(printf '%s' "\${args[$j]}" | jq '.revision -= 1')
        fi
      done
      ;;
    committed-timeout) "$SSS_TEST_REAL_CURL" "$@" >/dev/null; exit 28 ;;
  esac
fi
exec "$SSS_TEST_REAL_CURL" "\${args[@]}"
`, { mode: 0o755 });
    for (const mode of ['rejected', 'network', 'conflict', 'committed-timeout']) {
      const before = await remoteConfig();
      const name = `failed-${mode}`;
      const result = runCli(`2\n${name}\nZZ\nkvm\n\n0\n`, {
        PATH: `${fakeBin}:${process.env.PATH}`, SSS_TEST_REAL_CURL: realCurl, SSS_TEST_SUBMIT_MODE: mode,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.match(result.stdout, /操作未确认成功，已恢复远端配置/);
      assert.doesNotMatch(result.stdout, /添加成功|curl -fsSL|已提交到 Cloudflare/);
      const after = await remoteConfig();
      if (mode === 'committed-timeout') {
        assert.equal(after.revision, before.revision + 1, 'server commit can precede a lost response');
        assert.ok(after.config.servers.some(node => node.name === name));
        assert.equal((await putConfig(after.revision, before.config)).status, 200);
      } else {
        assert.deepEqual(after, before, 'failed mutation must not change remote configuration');
      }
    }
  });

  await t.test('Linux Agent report function submits authenticated metrics to the Worker', async () => {
    const agentProbe = spawnSync('python3', ['-c', [
      'import importlib.util, sys',
      'spec = importlib.util.spec_from_file_location("sss_agent", sys.argv[1])',
      'agent = importlib.util.module_from_spec(spec); spec.loader.exec_module(agent)',
      'agent.WORKER_URL = sys.argv[2]; agent.USER = "visible-user"; agent.PASSWORD = "visible-pass"',
      'agent.post_worker_report({"online4": True, "network_in": 300, "network_out": 400, "cpu": 9})',
    ].join('; ') , path.join(root, 'agent/client-linux.py'), baseUrl], {
      cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024,
    });
    assert.equal(agentProbe.status, 0, `${agentProbe.stdout}\n${agentProbe.stderr}`);
    const stats = await (await fetch(`${baseUrl}/json/stats.json`)).json();
    const node = stats.servers.find((server) => server.name === 'visible-online');
    assert.equal(node.online4, true);
    assert.equal(node.cpu, 9);
    assert.equal(node.network_in, 300);
  });

  await t.test('monthly traffic survives counter resets and new-period reports', async () => {
    async function send(rx, tx) {
      assert.equal((await fetch(`${baseUrl}/api/agent/report`, { method: 'POST', headers,
        body: JSON.stringify({ username: 'visible-user', password: 'visible-pass', metrics: { online4: true, network_in: rx, network_out: tx } }),
      })).status, 200);
      return (await (await fetch(`${baseUrl}/json/stats.json`)).json()).servers.find(n => n.username === 'visible-user');
    }
    let node = await send(500, 600);
    assert.equal(node.monthly_network_in, 400);
    node = await send(150, 250); // reboot: counter drops but is still above original baseline
    assert.equal(node.monthly_network_in, 550);
    assert.equal(node.monthly_network_out, 650);
    node = await send(180, 280);
    assert.equal(node.monthly_network_in, 580);
    runWrangler(['d1', 'execute', 'sss-server-status-local', '--local', '--config', 'wrangler.local.toml',
      '--persist-to', '.wrangler/test-state', '--command', "UPDATE agent_metrics SET traffic_period = '2000-01' WHERE username = 'visible-user'"]);
    node = await send(200, 300);
    assert.equal(node.monthly_network_in, 0);
  });

  await t.test('Agent installer creates a user service without requiring root', async () => {
    const agentHome = path.join(stateDir, 'unprivileged-agent-home');
    const fakeBin = path.join(stateDir, 'fake-bin');
    const serviceLog = path.join(stateDir, 'systemctl.log');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.mkdirSync(agentHome, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SSS_TEST_SYSTEMCTL_LOG"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'wget'), [
      '#!/bin/sh',
      'target="$2"; url="$3"',
      'printf "%s\\n" "$url" >> "$SSS_TEST_DOWNLOAD_LOG"',
      'case "$url" in',
      '  */sss-agent.service) cp "$SSS_TEST_SERVICE_SOURCE" "$target" ;;',
      '  */client-linux.py) cp "$SSS_TEST_AGENT_SOURCE" "$target" ;;',
      '  *) exit 2 ;;',
      'esac',
    ].join('\n') + '\n', { mode: 0o755 });

    const installOptions = {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: agentHome,
        PATH: `${fakeBin}:${process.env.PATH}`,
        SSS_TEST_SYSTEMCTL_LOG: serviceLog,
        SSS_TEST_DOWNLOAD_LOG: path.join(stateDir, 'agent-download.log'),
        GITHUB_RAW_URL: 'https://raw.githubusercontent.com/lidalao/ServerStatus/test-release',
        SSS_TEST_SERVICE_SOURCE: path.join(root, 'agent/sss-agent.service'),
        SSS_TEST_AGENT_SOURCE: path.join(root, 'agent/client-linux.py'),
      },
    };
    const legacy = spawnSync('bash', [path.join(root, 'agent/sss-agent.sh'), 'localhost', 'user', 'pass'], installOptions);
    assert.notEqual(legacy.status, 0, 'TCP installation is no longer supported');
    assert.match(legacy.stdout, /用法:.*--worker/);
    assert.equal(fs.existsSync(path.join(agentHome, '.local/share/sss/agent')), false);
    const install = spawnSync('bash', [path.join(root, 'agent/sss-agent.sh'), '--worker', baseUrl, 'unpriv-user', 'unpriv-pass'], installOptions);
    assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);

    const unitPath = path.join(agentHome, '.config/systemd/user/sss-agent.service');
    const agentPath = path.join(agentHome, '.local/share/sss/agent/client-linux.py');
    const unit = fs.readFileSync(unitPath, 'utf8');
    assert.match(unit, /%h\/.local\/share\/sss\/agent\/client-linux\.py/);
    assert.match(unit, /USER=unpriv-user/);
    assert.match(unit, /PASSWORD=unpriv-pass/);
    assert.match(unit, /WORKER_URL=http:\/\/127\.0\.0\.1:/);
    assert.equal(fs.statSync(unitPath).mode & 0o777, 0o600, 'credentials in the unit are private to this user');
    assert.equal(fs.statSync(path.dirname(agentPath)).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(agentPath), true);
    assert.match(fs.readFileSync(serviceLog, 'utf8'), /--user enable --now sss-agent/);
    const savedAgent = fs.readFileSync(agentPath, 'utf8');
    const update = spawnSync('bash', [path.join(root, 'agent/sss-agent.sh')], { ...installOptions, env: { ...installOptions.env, GITHUB_RAW_URL: '' }, input: '1\n' });
    assert.equal(update.status, 0, update.stdout + update.stderr);
    assert.equal(fs.readFileSync(unitPath, 'utf8'), unit, 'update preserves credentials');
    assert.match(fs.readFileSync(serviceLog, 'utf8'), /--user restart sss-agent/);
    const sourceConfig = path.join(path.dirname(agentPath), '.env');
    assert.match(fs.readFileSync(sourceConfig, 'utf8'), /GITHUB_RAW_URL=.*test-release/);
    assert.equal(fs.statSync(sourceConfig).mode & 0o777, 0o600);
    const downloads = fs.readFileSync(installOptions.env.SSS_TEST_DOWNLOAD_LOG, 'utf8');
    assert.match(downloads, /test-release\/agent\/client-linux.py/);
    assert.doesNotMatch(downloads, /ServerStatus\/master/);
    const managerReady = path.join(stateDir, 'agent-manager-ready');
    fs.writeFileSync(path.join(fakeBin, 'systemctl'), '#!/bin/sh\n[ "$1" = --user ] || exit 99\n[ "$XDG_RUNTIME_DIR" = "/run/user/$(id -u)" ] || exit 98\ncase "$DBUS_SESSION_BUS_ADDRESS" in ""|"unix:path=$XDG_RUNTIME_DIR/bus") ;; *) exit 97 ;; esac\n[ -f "$SSS_TEST_MANAGER_READY" ] || exit 1\nprintf "%s\\n" "$*" >> "$SSS_TEST_SYSTEMCTL_LOG"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'loginctl'), '#!/bin/sh\n[ "$1" = --no-ask-password ] && [ "$2" = enable-linger ] && [ "$3" = "$(id -un)" ] || exit 99\ntouch "$SSS_TEST_MANAGER_READY"\n', { mode: 0o755 });
    const recoveredInstall = spawnSync('bash', [path.join(root, 'agent/sss-agent.sh'), '--worker', baseUrl, 'unpriv-user', 'unpriv-pass'], {
      ...installOptions, env: { ...installOptions.env, XDG_RUNTIME_DIR: '/run/user/foreign', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/foreign/bus', SSS_TEST_MANAGER_READY: managerReady },
    });
    assert.equal(recoveredInstall.status, 0, recoveredInstall.stdout + recoveredInstall.stderr);
    assert.match(recoveredInstall.stdout, /自动修复/);
    assert.equal(fs.readFileSync(unitPath, 'utf8'), unit, 'reinstall repairs session and keeps the same node credentials');
    fs.writeFileSync(path.join(fakeBin, 'systemctl'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SSS_TEST_SYSTEMCTL_LOG"\n', { mode: 0o755 });

    const obsoleteSource = path.join(stateDir, 'obsolete-agent.py');
    fs.writeFileSync(obsoleteSource, '# old TCP Agent\nprint("Connecting...")\n');
    const rejected = spawnSync('bash', [path.join(root, 'agent/sss-agent.sh'), '--worker', baseUrl, 'new-user', 'new-pass'], {
      ...installOptions, env: { ...installOptions.env, SSS_TEST_AGENT_SOURCE: obsoleteSource },
    });
    assert.notEqual(rejected.status, 0, 'old TCP Agent download cannot replace the HTTPS Agent');
    assert.equal(fs.readFileSync(agentPath, 'utf8'), savedAgent);
    assert.equal(fs.readFileSync(unitPath, 'utf8'), unit);
    fs.writeFileSync(path.join(fakeBin, 'wget'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const failedUpdate = spawnSync('bash', [path.join(root, 'agent/sss-agent.sh'), '--worker', baseUrl, 'new-user', 'new-pass'], installOptions);
    assert.notEqual(failedUpdate.status, 0);
    assert.equal(fs.readFileSync(agentPath, 'utf8'), savedAgent);
    assert.equal(fs.readFileSync(unitPath, 'utf8'), unit);
    assert.doesNotMatch(fs.readFileSync(serviceLog, 'utf8'), /disable/);

    fs.writeFileSync(path.join(fakeBin, 'loginctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'sudo'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(fakeBin, 'systemctl'), '#!/bin/sh\necho "Failed to connect to bus: Permission denied" >&2\nexit 1\n', { mode: 0o755 });
    const unavailable = spawnSync('bash', [path.join(root, 'agent/sss-agent.sh'), '--worker', baseUrl, 'new-user', 'new-pass'], installOptions);
    assert.notEqual(unavailable.status, 0);
    assert.match(unavailable.stdout, /loginctl enable-linger/);
    assert.equal(fs.readFileSync(agentPath, 'utf8'), savedAgent);
    assert.equal(fs.readFileSync(unitPath, 'utf8'), unit);
    const refusedRemoval = spawnSync('bash', [path.join(root, 'agent/sss-agent.sh')], { ...installOptions, input: '2\n' });
    assert.notEqual(refusedRemoval.status, 0);
    assert.doesNotMatch(refusedRemoval.stdout, /卸载Agent完成/);
    assert.equal(fs.readFileSync(agentPath, 'utf8'), savedAgent);
    assert.equal(fs.readFileSync(unitPath, 'utf8'), unit);

  });

  await t.test('deleting a node clears its metrics before username reuse', async () => {
    const original = await remoteConfig();
    const trimmed = { ...original.config, servers: original.config.servers.filter(n => n.username !== 'visible-user') };
    assert.equal((await putConfig(original.revision, trimmed)).status, 200);
    assert.equal((await putConfig(original.revision + 1, original.config)).status, 200);
    const node = (await (await fetch(`${baseUrl}/json/stats.json`)).json()).servers.find(n => n.username === 'visible-user');
    assert.equal(node.last_seen, 0);
    assert.equal(node.online4, false);
  });

  await t.test('dashboard assets load without caching and phone CSS hides PROTO while keeping NETWORK', async () => {
    for (const asset of [
      '/', '/css/app.css', '/js/visibility.js', '/js/app.js', '/favicon.ico', '/favicon.png',
    ]) {
      const response = await fetch(`${baseUrl}${asset}`);
      assert.equal(response.status, 200, `${asset} loads`);
      assert.match(response.headers.get('cache-control'), /no-cache/);
    }
    const page = await (await fetch(`${baseUrl}/`)).text();
    assert.match(page, /visibility\.js/);
    const css = await (await fetch(`${baseUrl}/css/app.css`)).text();
    assertHiddenOnPhoneButNetworkVisible(css);
  });
});
