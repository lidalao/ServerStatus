import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A persistent local acceptance environment. All metrics below are simulated.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const state = '.wrangler/manual-state';
const port = Number(process.env.SSS_SMOKE_PORT || 8788);
assert.ok(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid SSS_SMOKE_PORT');
const url = `http://127.0.0.1:${port}`;
const token = 'local-test-token';
const wrangler = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG_PATH: path.join(root, state, 'wrangler.log') };
const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const socket = net.createServer();
await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(port, '127.0.0.1', resolve); });
await new Promise(resolve => socket.close(resolve));
mkdirSync(path.join(root, state), { recursive: true });
const migration = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'sss-server-status-local',
  '--local', '--config', 'wrangler.local.toml', '--persist-to', state], { cwd: root, env, stdio: 'inherit' });
assert.equal(migration.status, 0, 'Local D1 migration failed');
const worker = spawn(process.execPath, [wrangler, 'dev', '--config', 'wrangler.local.toml', '--ip', '127.0.0.1',
  '--port', String(port), '--persist-to', state], { cwd: root, env, stdio: 'inherit' });
let timer;
function stop() { clearInterval(timer); worker.kill('SIGTERM'); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
worker.once('exit', () => { clearInterval(timer); process.exitCode = process.exitCode || worker.exitCode || 0; });
const samples = [
  { name: 'smoke-online', username: 'smoke-online', password: 'local-online-pass', host: 'fixture', type: 'kvm', location: 'US', monthstart: '1', hidden: false },
  { name: 'smoke-offline', username: 'smoke-offline', password: 'local-offline-pass', host: 'fixture', type: 'kvm', location: 'JP', monthstart: '1', hidden: false },
  { name: 'smoke-hidden-online', username: 'smoke-hidden-online', password: 'local-hidden-online-pass', host: 'fixture', type: 'kvm', location: 'DE', monthstart: '1', hidden: true },
  { name: 'smoke-hidden-offline', username: 'smoke-hidden-offline', password: 'local-hidden-offline-pass', host: 'fixture', type: 'kvm', location: 'SG', monthstart: '1', hidden: true },
];
let counter = Math.floor(Date.now() / 1000) * 100000;
async function heartbeat() {
  counter += 1500000;
  for (const node of [samples[0], samples[2]]) {
    const response = await fetch(`${url}/api/agent/report`, {
      method: 'POST', headers,
      body: JSON.stringify({ username: node.username, password: node.password, metrics: {
        online4: true, online6: node.username === 'smoke-hidden-online', ip_status: true,
        uptime: 86400, load_1: 0.23, load_5: 0.18, load_15: 0.12, cpu: 27,
        network_rx: 120000, network_tx: 65000, network_in: counter, network_out: counter / 2,
        memory_total: 2097152, memory_used: 734003, swap_total: 0, swap_used: 0,
        hdd_total: 40960, hdd_used: 14336,
        ping_10010: 0, ping_189: 2, ping_10086: 0, time_10010: 130, time_189: 180, time_10086: 160,
        tcp: 12, udp: 3, process: 42, thread: 75,
      } }), signal: AbortSignal.timeout(10000),
    });
    // Deleting or changing credentials in the CLI must remain effective.
    if (response.status !== 401) assert.equal(response.status, 200, await response.text());
  }
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (worker.exitCode !== null) throw new Error('Local Worker exited before startup');
    try { ready = (await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (ready) break;
    await wait(250);
  }
  assert.ok(ready, 'Local Worker startup timed out');
  const configResponse = await fetch(`${url}/api/admin/config`, { headers });
  assert.equal(configResponse.status, 200);
  const current = await configResponse.json();
  if (current.revision === 0 && current.config.servers.length === 0) {
    const saved = await fetch(`${url}/api/admin/config`, { method: 'PUT', headers,
      body: JSON.stringify({ revision: 0, config: { servers: samples } }) });
    assert.equal(saved.status, 200);
  }
  await heartbeat();
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /visibility\.js/);
  const stats = await (await fetch(`${url}/json/stats.json`)).json();
  console.log('\nLOCAL SMOKE READY (simulated metrics; no Cloudflare account required)');
  console.log(`Dashboard: ${url}`);
  console.log(`CLI: SSS_WORKER_URL=${url} SSS_MANAGEMENT_TOKEN=${token} bash ./sss.sh`);
  console.log(`Nodes: ${stats.servers.map(n => `${n.name}: ${n.hidden ? 'hidden' : 'visible'}, ${n.online4 || n.online6 ? 'online' : 'offline'}`).join('; ')}`);
  console.log(`State: ${state} (separate from development and automated tests)`);
  console.log('Keep this process running. Online fixtures report every 15s. Ctrl+C stops it.');
  let reporting = false;
  timer = setInterval(async () => {
    if (reporting) return;
    reporting = true;
    try { await heartbeat(); } catch (error) { console.error('Fixture heartbeat:', error.message); }
    finally { reporting = false; }
  }, 15000);
} catch (error) {
  console.error(error);
  stop();
  process.exitCode = 1;
}
