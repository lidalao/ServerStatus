import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const keys = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'SSS_WORKER_NAME', 'SSS_D1_NAME', 'SSS_D1_ID',
  'SSS_REALTIME_INTERVAL', 'SSS_WORKER_URL', 'SSS_MANAGEMENT_TOKEN', 'TG_BOT_TOKEN', 'TG_CHAT_ID', 'GITHUB_RAW_URL', 'SSS_SETTINGS_BASELINE'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recoveryKeys = keys.filter(key => !key.startsWith('CLOUDFLARE_') && key !== 'SSS_SETTINGS_BASELINE');
const fingerprint = value => createHash('sha256').update(value || '').digest('hex');
const baseline = config => Buffer.from(JSON.stringify(Object.fromEntries(recoveryKeys.map(key => [key, fingerprint(config[key])])))).toString('base64');
const recoverySchema = "CREATE TABLE IF NOT EXISTS deployment_recovery (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL, updated_at INTEGER NOT NULL, lease_owner TEXT NOT NULL DEFAULT '', lease_until INTEGER NOT NULL DEFAULT 0)";
export const recoveryDatabaseName = worker => `sss-recovery-${createHash('sha256').update(worker).digest('hex').slice(0, 16)}`;

function accountApi(settings, request = fetch) {
  if (!/^[a-f0-9]{32}$/i.test(settings.CLOUDFLARE_ACCOUNT_ID || '') || !settings.CLOUDFLARE_API_TOKEN) {
    throw new Error('请在 .env 填写有效的 CLOUDFLARE_ACCOUNT_ID 和 CLOUDFLARE_API_TOKEN');
  }
  return async (route, method = 'GET', body) => {
    let response, payload;
    try {
      response = await request(`https://api.cloudflare.com/client/v4/accounts/${settings.CLOUDFLARE_ACCOUNT_ID}${route}`, {
        method, headers: { authorization: `Bearer ${settings.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
      });
      payload = await response.json();
    } catch { throw new Error('Cloudflare API 连接失败；未回写恢复配置'); }
    if (!response.ok || !payload.success) throw new Error(`Cloudflare API 失败 (${response.status}); 请检查账号与 Token 权限`);
    return payload.result;
  };
}

async function findRecoveryDatabase(api, worker) {
  const name = recoveryDatabaseName(worker);
  const list = await api(`/d1/database?name=${name}&per_page=100`);
  if (!Array.isArray(list)) throw new Error('恢复数据库列表格式无效');
  const matches = list.filter(database => database.name === name);
  if (matches.length > 1) throw new Error('恢复数据库不唯一；未修改本地配置');
  if (matches[0] && !uuid.test(matches[0].uuid || '')) throw new Error('恢复数据库 ID 无效');
  return matches[0];
}

async function recoveryQuery(api, id, sql, params = []) {
  const result = await api(`/d1/database/${id}/query`, 'POST', { sql, params });
  if (!Array.isArray(result) || !result.length || result.some(query => query.success !== true)) {
    throw new Error('恢复配置数据库操作失败');
  }
  return result[0].results || [];
}

async function backupSettings(api, config, database, owner) {
  if (!database) database = await api('/d1/database', 'POST', { name: recoveryDatabaseName(config.SSS_WORKER_NAME) });
  if (!uuid.test(database?.uuid || '') || database.uuid === config.SSS_D1_ID) throw new Error('恢复数据库无效，必须独立于节点数据库');
  await recoveryQuery(api, database.uuid, recoverySchema);
  const payload = JSON.stringify({ version: 1, config: Object.fromEntries(recoveryKeys.map(key => [key, config[key] || ''])) });
  if (owner) {
    const updated = await recoveryQuery(api, database.uuid,
      "UPDATE deployment_recovery SET payload = ?, updated_at = ?, lease_owner = '', lease_until = 0 WHERE id = 1 AND lease_owner = ? AND lease_until > ? RETURNING id",
      [payload, Math.floor(Date.now() / 1000), owner, Math.floor(Date.now() / 1000)]);
    if (updated.length !== 1) throw new Error('部署锁已失效，恢复备份未更新');
  } else {
    await recoveryQuery(api, database.uuid,
      'INSERT INTO deployment_recovery (id, payload, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updated_at=excluded.updated_at',
      [payload, Math.floor(Date.now() / 1000)]);
  }
}

async function loadRecovery(api, database, worker, allowEmpty = false) {
  const rows = await recoveryQuery(api, database.uuid, 'SELECT payload FROM deployment_recovery WHERE id = 1');
  if (!rows.length && allowEmpty) return null;
  let payload;
  try { payload = JSON.parse(rows[0]?.payload); } catch { throw new Error('恢复备份缺失或损坏；未修改本地配置'); }
  const restored = payload?.config;
  if (payload?.version !== 1 || !restored || typeof restored !== 'object' || Array.isArray(restored) ||
      recoveryKeys.some(key => typeof restored[key] !== 'string' || /[\r\n\0]/.test(restored[key]) || restored[key].length > 8192) ||
      restored.SSS_WORKER_NAME !== worker || !uuid.test(restored.SSS_D1_ID) || !restored.SSS_MANAGEMENT_TOKEN ||
      !/^https:\/\/[^\s]+$/.test(restored.SSS_WORKER_URL) || !/^[a-zA-Z0-9_-]{1,64}$/.test(restored.SSS_D1_NAME) ||
      !/^(?:[1-9]|[1-5][0-9]|60)$/.test(restored.SSS_REALTIME_INTERVAL) ||
      (!!restored.TG_BOT_TOKEN !== !!restored.TG_CHAT_ID) ||
      !/^https:\/\/raw\.githubusercontent\.com\/[\w.-]+\/[\w.-]+\/.+$/.test(restored.GITHUB_RAW_URL)) {
    throw new Error('恢复备份校验失败；未修改本地配置');
  }
  return Object.fromEntries(recoveryKeys.map(key => [key, restored[key]]));
}

export async function recoverSettings({ settingsPath, settings, api, request = fetch, emit = console.log }) {
  const worker = settings.SSS_WORKER_NAME || 'sss-server-status';
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(worker)) throw new Error('SSS_WORKER_NAME 格式无效');
  api ||= accountApi(settings, request);
  const database = await findRecoveryDatabase(api, worker);
  if (!database) {
    const workers = await api('/workers/scripts');
    if (!Array.isArray(workers)) throw new Error('Worker 列表返回格式无效');
    if (workers.some(item => item.id === worker)) throw new Error('现有服务尚无恢复备份；请在原管理机器使用原 .env 执行 update 一次，然后重试 init。不会重新生成管理 Token。');
    emit('尚未找到已有服务，保留本地配置；首次部署请执行 deploy。');
    return null;
  }
  const restored = await loadRecovery(api, database, worker);
  const merged = { ...settings, ...restored, SSS_SETTINGS_BASELINE: baseline(restored) };
  // Never trust a backup's account/API credentials. Each machine supplies its own.
  const db = await api(`/d1/database/${restored.SSS_D1_ID}`);
  if (db?.name !== restored.SSS_D1_NAME) throw new Error('恢复备份的节点数据库与当前账号不匹配；未修改本地配置');
  const workers = await api('/workers/scripts');
  if (!Array.isArray(workers) || !workers.some(item => item.id === worker)) throw new Error('恢复备份对应的 Worker 不存在；未修改本地配置');
  saveSettings(settingsPath, merged);
  emit('已从 CF 私有备份恢复管理和部署配置（凭据不显示）；运行 bash ./sss.sh 管理节点。');
  return merged;
}

async function mergeRemoteSettings(api, database, config) {
  if (!database) return;
  // An interrupted first backup may have created only an empty database/table.
  // Repair it only during a deploy from a complete existing local configuration.
  await recoveryQuery(api, database.uuid, recoverySchema);
  const remote = await loadRecovery(api, database, config.SSS_WORKER_NAME, true);
  if (!remote) {
    if (!config.SSS_D1_ID || !config.SSS_WORKER_URL || !config.SSS_MANAGEMENT_TOKEN) throw new Error('恢复备份尚未初始化，请使用原管理机器的完整 .env 更新');
    return;
  }
  let previous = {};
  if (config.SSS_SETTINGS_BASELINE) {
    try { previous = JSON.parse(Buffer.from(config.SSS_SETTINGS_BASELINE, 'base64').toString()); }
    catch { throw new Error('本地同步基线无效；请执行 bash ./sss.sh sync'); }
    if (!previous || recoveryKeys.some(key => !/^[a-f0-9]{64}$/.test(previous[key] || ''))) throw new Error('本地同步基线无效；请执行 bash ./sss.sh sync');
  }
  const conflicts = [];
  for (const key of recoveryKeys) {
    const local = config[key] || '';
    if (local === remote[key]) continue;
    if (!config.SSS_SETTINGS_BASELINE) { conflicts.push(key); continue; }
    if (fingerprint(local) === previous[key]) config[key] = remote[key];
    else if (fingerprint(remote[key]) !== previous[key]) conflicts.push(key);
  }
  if (conflicts.length) throw new Error(`本地与远端配置冲突 (${conflicts.join(', ')})；未部署。先执行 bash ./sss.sh sync，再修改希望发布的值并 update。`);
  return JSON.stringify({ version: 1, config: remote });
}

export function saveSettings(filename, config) {
  const previous = existsSync(filename) ? readFileSync(filename, 'utf8').replace(/^\uFEFF/, '') : '';
  const remaining = new Set(keys);
  const lines = previous.split(/\r?\n/).flatMap(line => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!match || !keys.includes(match[1])) return [line];
    if (!remaining.delete(match[1])) return [];
    return [`${match[1]}=${config[match[1]] || ''}`];
  });
  for (const key of remaining) lines.push(`${key}=${config[key] || ''}`);
  mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, filename);
    chmodSync(filename, 0o600);
  } finally { rmSync(temporary, { force: true }); }
}

async function runCommand(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'inherit', 'inherit'] });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`部署命令失败 (${command}, exit ${code})`)));
  });
}

export async function deploy({ root = rootDirectory, settingsPath, settings, plan = false,
  api, run = runCommand, request = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), emit = console.log } = {}) {
  const config = Object.fromEntries(keys.map(key => [key, settings[key] || '']));
  config.SSS_WORKER_NAME ||= 'sss-server-status';
  config.SSS_D1_NAME ||= config.SSS_WORKER_NAME;
  config.SSS_REALTIME_INTERVAL ||= '2';
  if (!/^(?:[1-9]|[1-5][0-9]|60)$/.test(String(config.SSS_REALTIME_INTERVAL))) throw new Error('SSS_REALTIME_INTERVAL 必须是 1–60 的整数秒');
  for (const value of Object.values(config)) {
    if (/[\r\n\0]/.test(value)) throw new Error('配置必须使用单行值');
  }
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(config.SSS_WORKER_NAME)) throw new Error('SSS_WORKER_NAME 格式无效');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(config.SSS_D1_NAME)) throw new Error('SSS_D1_NAME 格式无效');
  if (config.SSS_D1_ID && !uuid.test(config.SSS_D1_ID)) throw new Error('SSS_D1_ID 必须是数据库 UUID');
  if (!!config.TG_BOT_TOKEN !== !!config.TG_CHAT_ID) throw new Error('Telegram 的 Token 与 Chat ID 必须同时填写或同时留空');
  if (config.SSS_WORKER_URL && !/^https:\/\/[^\s]+$/.test(config.SSS_WORKER_URL)) throw new Error('生产 Worker 地址必须使用 HTTPS');
  emit(`部署目标: Worker=${config.SSS_WORKER_NAME}, D1=${config.SSS_D1_NAME}`);
  emit(`配置文件: ${settingsPath}`);
  if (plan) {
    emit('预览：检查构建 → 查找/创建 D1 → 应用迁移 → 发布 Web/API 和 Secrets → 验证管理 API → 保存地址');
    emit('预览不会联网、写入配置或部署。');
    return config;
  }
  if (!/^[a-f0-9]{32}$/i.test(config.CLOUDFLARE_ACCOUNT_ID)) throw new Error('请在 .env 填写有效 CLOUDFLARE_ACCOUNT_ID');
  if (!config.CLOUDFLARE_API_TOKEN) throw new Error('请在 .env 填写 CLOUDFLARE_API_TOKEN');
  if (config.SSS_WORKER_URL && !config.SSS_MANAGEMENT_TOKEN) {
    throw new Error('更新已有 Worker 必须保留原 SSS_MANAGEMENT_TOKEN，避免意外更换节点管理凭据');
  }
  api ||= accountApi(config, request);
  const recoveryDatabase = await findRecoveryDatabase(api, config.SSS_WORKER_NAME);
  const expectedPayload = await mergeRemoteSettings(api, recoveryDatabase, config);
  const generatedToken = !config.SSS_MANAGEMENT_TOKEN;
  config.SSS_MANAGEMENT_TOKEN ||= randomBytes(32).toString('hex');
  const environment = { ...process.env, CLOUDFLARE_API_TOKEN: config.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: config.CLOUDFLARE_ACCOUNT_ID, WRANGLER_SEND_METRICS: 'false', CI: 'true' };
  const invoke = (command, args) => run(command, args, { cwd: root, env: environment });
  const cli = path.join(root, 'node_modules/wrangler/bin/wrangler.js');
  const expected = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies.wrangler;
  const installed = path.join(root, 'node_modules/wrangler/package.json');
  if (!existsSync(installed) || JSON.parse(readFileSync(installed, 'utf8')).version !== expected) {
    emit('安装项目锁定的部署依赖…');
    await invoke('npm', ['ci']);
  }
  const outputDirectory = path.join(root, '.wrangler/deploy');
  mkdirSync(outputDirectory, { recursive: true });
  const temporary = mkdtempSync(path.join(outputDirectory, 'run-'));
  let leaseOwner;
  try {
    const generated = path.join(temporary, 'wrangler.json');
    const writeConfig = databaseId => writeFileSync(generated, JSON.stringify({
      name: config.SSS_WORKER_NAME, account_id: config.CLOUDFLARE_ACCOUNT_ID,
      main: path.join(root, 'cloudflare/worker.js'), compatibility_date: '2026-09-01', workers_dev: true,
      assets: { directory: path.join(root, 'service/web'), binding: 'ASSETS', run_worker_first: ['/api/*', '/json/*'] },
      vars: { SSS_REALTIME_INTERVAL: String(config.SSS_REALTIME_INTERVAL) },
      durable_objects: { bindings: [{ name: 'REALTIME', class_name: 'RealtimeHub' }] },
      migrations: [{ tag: 'realtime-v1', new_sqlite_classes: ['RealtimeHub'] }],
      d1_databases: [{ binding: 'DB', database_name: config.SSS_D1_NAME, database_id: databaseId,
        migrations_dir: path.join(root, 'cloudflare/migrations') }], triggers: { crons: ['* * * * *'] },
    }, null, 2));
    writeConfig(config.SSS_D1_ID || '00000000-0000-0000-0000-000000000001');
    emit('先验证 Worker 构建…');
    await invoke(process.execPath, [cli, 'deploy', '--config', generated, '--dry-run']);
    if (generatedToken) {
      const workers = await api('/workers/scripts');
      if (!Array.isArray(workers)) throw new Error('Worker 列表返回格式无效');
      if (workers.some(worker => worker.id === config.SSS_WORKER_NAME)) {
        throw new Error('同名 Worker 已存在，请填写原 SSS_MANAGEMENT_TOKEN 后重试；不会自动更换现有凭据');
      }
    }
    const account = await api('/workers/subdomain');
    if (!account?.subdomain || !/^[a-z0-9-]+$/i.test(account.subdomain)) {
      throw new Error('账号尚未启用 workers.dev 子域名，请先在 CF Workers 页面启用');
    }
    const defaultUrl = `https://${config.SSS_WORKER_NAME}.${account.subdomain}.workers.dev`;
    if (config.SSS_WORKER_URL && new URL(config.SSS_WORKER_URL).hostname.endsWith('.workers.dev') &&
        new URL(config.SSS_WORKER_URL).origin !== defaultUrl) {
      throw new Error('SSS_WORKER_URL 与 Worker 名称或 CF 账号不匹配，请检查 .env');
    }
    if (recoveryDatabase && expectedPayload) {
      const owner = randomBytes(16).toString('hex');
      const now = Math.floor(Date.now() / 1000);
      const acquired = await recoveryQuery(api, recoveryDatabase.uuid,
        'UPDATE deployment_recovery SET lease_owner = ?, lease_until = ? WHERE id = 1 AND lease_until <= ? AND payload = ? RETURNING id',
        [owner, now + 900, now, expectedPayload]);
      if (acquired.length !== 1) throw new Error('另一台机器正在部署或远端配置已变化；未部署，请稍后 sync 再重试。');
      leaseOwner = owner;
    }
    saveSettings(settingsPath, config); // Persist credentials before creating or updating remote resources.
    if (!config.SSS_D1_ID) {
      const matches = await api(`/d1/database?name=${encodeURIComponent(config.SSS_D1_NAME)}&per_page=100`);
      if (!Array.isArray(matches)) throw new Error('D1 列表返回格式无效');
      const existing = matches.filter(item => item.name === config.SSS_D1_NAME);
      if (existing.length > 1) throw new Error('发现重名数据库，请明确填写 SSS_D1_ID');
      const database = existing[0] || await api('/d1/database', 'POST', { name: config.SSS_D1_NAME });
      config.SSS_D1_ID = database?.uuid;
      if (!uuid.test(config.SSS_D1_ID || '')) throw new Error('Cloudflare 未返回有效 D1 ID');
      saveSettings(settingsPath, config);
    } else {
      const database = await api(`/d1/database/${config.SSS_D1_ID}`);
      if (database?.name !== config.SSS_D1_NAME) throw new Error('D1 ID 与名称不匹配，请检查 .env');
    }
    writeConfig(config.SSS_D1_ID);
    emit('应用数据库迁移…');
    await invoke(process.execPath, [cli, 'd1', 'migrations', 'apply', config.SSS_D1_NAME, '--remote', '--config', generated]);
    const secrets = path.join(temporary, 'secrets.json');
    writeFileSync(secrets, JSON.stringify({ SSS_MANAGEMENT_TOKEN: config.SSS_MANAGEMENT_TOKEN,
      TG_BOT_TOKEN: config.TG_BOT_TOKEN, TG_CHAT_ID: config.TG_CHAT_ID }), { mode: 0o600, flag: 'wx' });
    emit('发布 Web、API 和通知配置…');
    await invoke(process.execPath, [cli, 'deploy', '--config', generated, '--secrets-file', secrets]);
    config.SSS_WORKER_URL ||= defaultUrl;
    saveSettings(settingsPath, config);
    emit('验证部署后的管理 API…');
    const verificationUrls = [...new Set([defaultUrl, config.SSS_WORKER_URL.replace(/\/$/, '')])];
    for (const targetUrl of verificationUrls) {
      let verified = false;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          const response = await request(`${targetUrl}/api/admin/config`, {
            headers: { authorization: `Bearer ${config.SSS_MANAGEMENT_TOKEN}` }, signal: AbortSignal.timeout(10000),
          });
          const body = await response.json();
          verified = response.ok && Number.isSafeInteger(body.revision) && Array.isArray(body.config?.servers);
        } catch {}
        if (verified) break;
        await sleep(2000);
      }
      if (!verified) throw new Error('发布已完成，地址已保存，但管理 API 验证失败；请检查 Worker 地址/域名后重试');
    }
    emit('保存跨机器恢复配置到独立私有数据库…');
    try { await backupSettings(api, config, recoveryDatabase, leaseOwner); }
    catch { throw new Error('CF 发布和验证已完成，但恢复备份保存失败；请检查 D1 权限/数据库额度并重试 update。本地配置已保留。'); }
    config.SSS_SETTINGS_BASELINE = baseline(config);
    saveSettings(settingsPath, config);
    emit(`部署成功: ${config.SSS_WORKER_URL}`);
    emit('配置已写回 .env。运行 bash ./sss.sh 即可管理节点。');
    return config;
  } finally {
    if (leaseOwner) {
      try { await recoveryQuery(api, recoveryDatabase.uuid, "UPDATE deployment_recovery SET lease_owner = '', lease_until = 0 WHERE id = 1 AND lease_owner = ?", [leaseOwner]); }
      catch {} // A killed/unreachable deploy releases its lease after 15 minutes.
    }
    rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] !== '--settings' || !args[1] || args.slice(2).some(value => !['--plan', '--recover'].includes(value)) || (args.includes('--plan') && args.includes('--recover'))) throw new Error('无效参数');
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('部署需要 Node.js 22+');
    if (args.includes('--recover')) await recoverSettings({ settingsPath: path.resolve(args[1]), settings: process.env });
    else await deploy({ settingsPath: path.resolve(args[1]), settings: process.env, plan: args.includes('--plan') });
  } catch (error) {
    let message = error.message;
    for (const key of ['CLOUDFLARE_API_TOKEN', 'SSS_MANAGEMENT_TOKEN', 'TG_BOT_TOKEN']) {
      if (process.env[key]) message = message.replaceAll(process.env[key], '[redacted]');
    }
    console.error(message);
    process.exitCode = 1;
  }
}
