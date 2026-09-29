const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');

test('Agent parses exact keys and retains IPv6-only status between samples', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util
from unittest.mock import patch
spec = importlib.util.spec_from_file_location('agent', 'agent/client-linux.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
a.configure(['REPORT_INTERVAL=15', 'INTERVAL=2', 'USER=USER=abc', 'WORKER_URL=https://example.com'])
assert a.REPORT_INTERVAL == 15 and a.USER == 'USER=abc'
for argument in ['INTERVAL=0', 'REPORT_INTERVAL=-1', 'PORT=35601', 'SERVER=localhost', 'XPORT=2']:
    try:
        a.configure([argument])
    except ValueError:
        pass
    else:
        raise AssertionError(argument)
with patch.object(a, 'get_cpu', return_value=1), patch.object(a, 'liuliang', return_value=(100, 200)), patch.object(a, 'get_uptime', return_value=100), patch.object(a.os, 'getloadavg', return_value=(0, 0, 0)), patch.object(a, 'get_memory', return_value=(100, 20, 0, 0)), patch.object(a, 'get_hdd', return_value=(100, 10)), patch.object(a, 'tupd', return_value=(0, 0, 0, 0)), patch.object(a, 'get_network', side_effect=lambda family: family == 6) as check:
    first, timer = a.collect_metrics()
    second, timer = a.collect_metrics(timer=timer)
    assert first['online4'] is False and first['online6'] is True
    assert second['online4'] is False and second['online6'] is True
    assert check.call_count == 2
`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('failed Telegram delivery retries hidden-node transitions and records only success', async () => {
  const source = fs.readFileSync(path.join(root, 'cloudflare/worker.js'), 'utf8');
  const { default: worker } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  let state = 1;
  let seen = 0;
  const env = { TG_BOT_TOKEN: 'test', TG_CHAT_ID: 'test', DB: {
    prepare(sql) {
      let args;
      return {
        bind(...values) { args = values; return this; },
        async first() { return { config_json: JSON.stringify({ servers: [{ name: '<hidden>', username: 'u', hidden: true }] }) }; },
        async all() { return { results: sql.includes('notification_state') ? [{ username: 'u', is_online: state }] : [{ username: 'u', last_seen: seen }] }; },
        async run() { if (sql.startsWith('UPDATE notification_state')) state = args[0]; },
      };
    },
  } };
  const originalFetch = global.fetch;
  const messages = [];
  let succeed = false;
  global.fetch = async (_url, options) => {
    messages.push(JSON.parse(options.body).text);
    return new Response(JSON.stringify({ ok: succeed }), { status: succeed ? 200 : 500 });
  };
  async function tick() {
    let pending;
    await worker.scheduled({}, env, { waitUntil(promise) { pending = promise; } });
    return pending;
  }
  try {
    await assert.rejects(tick(), /Telegram notification failed/);
    assert.equal(state, 1);
    succeed = true;
    await tick();
    assert.equal(state, 0);
    assert.match(messages[1], /主机下线：&lt;hidden&gt;/);
    await tick();
    assert.equal(messages.length, 2, 'no repeated notification after success');
    seen = Math.floor(Date.now() / 1000);
    await tick();
    assert.equal(state, 1);
    assert.match(messages[2], /主机上线/);
  } finally { global.fetch = originalFetch; }
});

test('monthly reset day clamps correctly in short months and leap years', async () => {
  const source = fs.readFileSync(path.join(root, 'cloudflare/worker.js'), 'utf8') + '\nexport { trafficPeriod };';
  const { trafficPeriod } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const period = (date, day) => trafficPeriod(Date.parse(date) / 1000, day);
  assert.equal(period('2026-02-27T12:00:00Z', 31), '2026-01');
  assert.equal(period('2026-02-28T00:00:00Z', 31), '2026-02');
  assert.equal(period('2028-02-28T12:00:00Z', 31), '2028-01');
  assert.equal(period('2028-02-29T00:00:00Z', 31), '2028-02');
  assert.equal(period('2026-01-01T00:00:00Z', 5), '2025-12');
});

test('Agent counts one-way traffic and reports nonnegative rates after counter resets', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util
from unittest.mock import patch, mock_open
spec = importlib.util.spec_from_file_location('agent', 'agent/client-linux.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
assert a.AGENT_PROTOCOL == 'sss-worker-https-v1'
data = 'Inter-| Receive | Transmit\\n face | bytes | bytes\\n eth0: 100 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\\n eth1: 0 0 0 0 0 0 0 0 200 0 0 0 0 0 0 0\\n lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0\\n'
with patch('builtins.open', mock_open(read_data=data)):
    assert a.liuliang() == (100, 200)
snapshots = []
def sleep(_):
    snapshots.append((a.netSpeed['netrx'], a.netSpeed['nettx']))
    if len(snapshots) == 3:
        raise StopIteration
with patch.object(a, 'liuliang', side_effect=[(100, 200), (200, 400), (50, 80)]), patch.object(a.time, 'monotonic', side_effect=[10, 12, 14]), patch.object(a.time, 'sleep', side_effect=sleep):
    try:
        a._net_speed()
    except StopIteration:
        pass
assert snapshots == [(0, 0), (50, 100), (0, 0)], snapshots
`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('dashboard handles reserved node names, closes offline details and keeps last view on HTTP errors', async () => {
  const vm = require('node:vm');
  const elements = { rows: { innerHTML: '', querySelectorAll: () => [] }, summary: {}, updated: {} };
  let detailRows = [];
  const context = vm.createContext({
    window: { matchMedia: () => ({ matches: false }) },
    document: { getElementById: id => elements[id], querySelectorAll: selector => selector === '#rows .exrow' ? detailRows : [] },
    SSSVisibility: require('../service/web/js/visibility.js'),
    requestAnimationFrame: () => {},
    fetch: async () => new Response(JSON.stringify({ servers: [] }), { status: 503 }),
  });
  const source = fs.readFileSync(path.join(root, 'service/web/js/app.js'), 'utf8')
    .replace(/  initTheme\(\);[\s\S]*?\}\)\(\);\s*$/, '  globalThis.dashboard = { S: S, render: render, tick: tick, applyExpanded: applyExpanded };\n})();');
  vm.runInContext(source, context);
  const dashboard = context.dashboard;
  dashboard.render({ servers: [{ name: '__proto__', online4: true }, { name: 'constructor', online4: true }] });
  assert.match(elements.rows.innerHTML, /data-for="__proto__" hidden/);
  assert.match(elements.rows.innerHTML, /data-for="constructor" hidden/);
  dashboard.S.expanded.__proto__ = true;
  let hidden = false;
  detailRows = [{ getAttribute: () => '__proto__', setAttribute: () => { hidden = true; }, removeAttribute: () => { hidden = false; } }];
  dashboard.S.servers[0].online4 = false;
  dashboard.applyExpanded();
  assert.equal(hidden, true, 'offline node no longer retains stale expanded metrics');
  const previous = elements.rows.innerHTML;
  dashboard.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(elements.rows.innerHTML, previous, '503 JSON must not clear a valid dashboard');
});

test('manual smoke failure retains a failing exit status when Worker cleanup succeeds', async t => {
  const os = require('node:os');
  const net = require('node:net');
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sss-smoke-failure-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'node_modules/wrangler/bin'), { recursive: true });
  fs.copyFileSync(path.join(root, 'scripts/local-smoke.mjs'), path.join(directory, 'scripts/local-smoke.mjs'));
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  fs.writeFileSync(path.join(directory, 'node_modules/wrangler/bin/wrangler.js'), `
    if (process.argv.includes('dev')) {
      require('node:http').createServer((req, res) => {
        res.writeHead(req.url === '/api/health' ? 200 : 500);
        res.end('{}');
      }).listen(${port}, '127.0.0.1');
      process.on('SIGTERM', () => process.exit(0));
    }
  `);
  const child = spawn(process.execPath, ['scripts/local-smoke.mjs'], {
    cwd: directory, env: { ...process.env, SSS_SMOKE_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', value => { output += value; });
  child.stderr.on('data', value => { output += value; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
  t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill('SIGKILL'); });
  const [code] = await once(child, 'exit');
  clearTimeout(timeout);
  assert.match(output, /500/);
  assert.equal(code, 1, output);
});
