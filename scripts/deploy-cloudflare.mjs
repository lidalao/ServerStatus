import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const keys = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'SSS_WORKER_NAME', 'SSS_D1_NAME', 'SSS_D1_ID',
  'SSS_WORKER_URL', 'SSS_MANAGEMENT_TOKEN', 'TG_BOT_TOKEN', 'TG_CHAT_ID', 'GITHUB_RAW_URL'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  api ||= async (route, method = 'GET', body) => {
    const response = await request(`https://api.cloudflare.com/client/v4/accounts/${config.CLOUDFLARE_ACCOUNT_ID}${route}`, {
      method, headers: { authorization: `Bearer ${config.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) throw new Error(`Cloudflare API 失败 (${response.status}); 请检查账号与 Token 权限`);
    return payload.result;
  };
  const outputDirectory = path.join(root, '.wrangler/deploy');
  mkdirSync(outputDirectory, { recursive: true });
  const temporary = mkdtempSync(path.join(outputDirectory, 'run-'));
  try {
    const generated = path.join(temporary, 'wrangler.json');
    const writeConfig = databaseId => writeFileSync(generated, JSON.stringify({
      name: config.SSS_WORKER_NAME, account_id: config.CLOUDFLARE_ACCOUNT_ID,
      main: path.join(root, 'cloudflare/worker.js'), compatibility_date: '2026-09-01', workers_dev: true,
      assets: { directory: path.join(root, 'service/web'), binding: 'ASSETS', run_worker_first: ['/*'] },
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
    emit(`部署成功: ${config.SSS_WORKER_URL}`);
    emit('配置已写回 .env。运行 bash ./sss.sh 即可管理节点。');
    return config;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args[0] !== '--settings' || !args[1] || args.slice(2).some(value => value !== '--plan')) throw new Error('无效参数');
    if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('部署需要 Node.js 22+');
    await deploy({ settingsPath: path.resolve(args[1]), settings: process.env, plan: args.includes('--plan') });
  } catch (error) {
    let message = error.message;
    for (const key of ['CLOUDFLARE_API_TOKEN', 'SSS_MANAGEMENT_TOKEN', 'TG_BOT_TOKEN']) {
      if (process.env[key]) message = message.replaceAll(process.env[key], '[redacted]');
    }
    console.error(message);
    process.exitCode = 1;
  }
}
