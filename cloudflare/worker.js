const OFFLINE_AFTER_SECONDS = 180;
const MAX_CONFIG_BYTES = 256 * 1024;
const MAX_REPORT_BYTES = 32 * 1024;
const AGENT_METRIC_FIELDS = new Set([
  "uptime", "load_1", "load_5", "load_15", "ping_10010", "ping_189", "ping_10086",
  "time_10010", "time_189", "time_10086", "tcp", "udp", "process", "thread",
  "network_rx", "network_tx", "network_in", "network_out", "memory_total", "memory_used",
  "swap_total", "swap_used", "hdd_total", "hdd_used", "cpu", "online4", "online6", "ip_status",
]);

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extraHeaders },
  });
}

function text(message, status = 400) {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function safeEqual(left, right) {
  const a = new TextEncoder().encode(String(left || ""));
  const b = new TextEncoder().encode(String(right || ""));
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) diff |= (a[i] || 0) ^ (b[i] || 0);
  return diff === 0;
}

function bearer(request) {
  const header = request.headers.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function authorized(request, env) {
  return !!env.SSS_MANAGEMENT_TOKEN && safeEqual(bearer(request), env.SSS_MANAGEMENT_TOKEN);
}

async function readBody(request, maxBytes) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = []; let length = 0;
  // Drain oversize input without retaining it. Cancelling a proxied body can
  // abort the transport before the 413 response and poison a keep-alive client.
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length <= maxBytes) chunks.push(value);
  }
  if (length > maxBytes) throw new Error('Request body is too large');
  const body = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}

async function readJson(request, maxBytes) {
  return JSON.parse(new TextDecoder().decode(await readBody(request, maxBytes)));
}

function validConfig(config) {
  if (!config || !Array.isArray(config.servers) || config.servers.length > 500) return false;
  const names = new Set();
  const usernames = new Set();
  for (const server of config.servers) {
    if (!server || typeof server !== "object") return false;
    if (!["name", "username", "password"].every((key) => typeof server[key] === "string" && server[key].trim())) return false;
    if (!["host", "type", "location"].every(key => server[key] === undefined || typeof server[key] === "string")) return false;
    if (server.monthstart !== undefined && (!(typeof server.monthstart === "string" || typeof server.monthstart === "number") || !/^(?:[1-9]|[12][0-9]|3[01])$/.test(String(server.monthstart)))) return false;
    if (server.hidden !== undefined && typeof server.hidden !== "boolean") return false;
    if (names.has(server.name) || usernames.has(server.username)) return false;
    names.add(server.name);
    usernames.add(server.username);
  }
  return true;
}

async function getConfig(env) {
  return env.DB.prepare("SELECT revision, config_json, updated_at FROM app_config WHERE id = 1").first();
}

async function adminConfig(request, env) {
  if (!authorized(request, env)) return json({ error: "Unauthorized" }, 401);
  if (request.method === "GET") {
    const row = await getConfig(env);
    if (!row) return json({ error: "Configuration is not initialized" }, 500);
    return json({ revision: row.revision, config: JSON.parse(row.config_json), updated_at: row.updated_at });
  }
  if (request.method !== "PUT") return text("Method not allowed", 405);

  let body;
  try { body = await readJson(request, MAX_CONFIG_BYTES); }
  catch (error) { return json({ error: error.message === "Request body is too large" ? error.message : "Invalid JSON" }, error.message === "Request body is too large" ? 413 : 400); }

  if (!body || !validConfig(body.config)) return json({ error: "Invalid configuration" }, 400);
  const expectedRevision = body.revision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return json({ error: "A valid revision is required" }, 400);

  const results = await env.DB.batch([
    env.DB.prepare("UPDATE app_config SET config_json = ?, revision = revision + 1, updated_at = ? WHERE id = 1 AND revision = ?")
      .bind(JSON.stringify(body.config), Math.floor(Date.now() / 1000), expectedRevision),
    env.DB.prepare(`DELETE FROM agent_metrics WHERE username NOT IN
      (SELECT json_extract(value, '$.username') FROM json_each((SELECT config_json FROM app_config WHERE id = 1), '$.servers'))`),
    env.DB.prepare(`DELETE FROM notification_state WHERE username NOT IN
      (SELECT json_extract(value, '$.username') FROM json_each((SELECT config_json FROM app_config WHERE id = 1), '$.servers'))`),
  ]);
  const result = results[0];

  if (!result.meta || result.meta.changes !== 1) {
    const latest = await getConfig(env);
    return json({ error: "Configuration changed remotely; pull the latest copy and retry", revision: latest ? latest.revision : null }, 409);
  }
  return json({ ok: true, revision: expectedRevision + 1 });
}

function trafficPeriod(now, monthstart) {
  const day = Math.max(1, Math.min(31, parseInt(monthstart, 10) || 1));
  const d = new Date(now * 1000);
  let year = d.getUTCFullYear(), month = d.getUTCMonth();
  if (d.getUTCDate() < Math.min(day, new Date(Date.UTC(year, month + 1, 0)).getUTCDate())) { month -= 1; if (month < 0) { month = 11; year -= 1; } }
  return year + "-" + String(month + 1).padStart(2, "0");
}

async function report(request, env, live = null) {
  if (request.method !== "POST") return text("Method not allowed", 405);
  let body;
  try { body = await readJson(request, MAX_REPORT_BYTES); }
  catch (error) { return json({ error: error.message === "Request body is too large" ? error.message : "Invalid JSON" }, error.message === "Request body is too large" ? 413 : 400); }
  if (!body || typeof body.username !== "string" || typeof body.password !== "string" || !body.metrics || typeof body.metrics !== "object" || Array.isArray(body.metrics)) {
    return json({ error: "username, password and metrics are required" }, 400);
  }

  const configRow = live ? live.config : await getConfig(env);
  if (!configRow) return json({ error: "Configuration is not initialized" }, 500);
  const config = JSON.parse(configRow.config_json);
  const node = config.servers.find((item) => item.username === body.username);
  if (!node || !safeEqual(node.password, body.password)) return json({ error: "Invalid credentials" }, 401);

  for (const [key, value] of Object.entries(body.metrics)) {
    if (!AGENT_METRIC_FIELDS.has(key)) continue;
    const boolean = ["online4", "online6", "ip_status"].includes(key);
    if (boolean ? typeof value !== "boolean" : typeof value !== "number" || !Number.isFinite(value)) {
      return json({ error: "Invalid metric: " + key }, 400);
    }
    if (["network_in", "network_out"].includes(key) && value < 0) return json({ error: "Invalid traffic counter" }, 400);
  }
  if (!["network_in", "network_out"].every((key) => Number.isSafeInteger(body.metrics[key]))) {
    return json({ error: "Traffic counters must be nonnegative safe integers" }, 400);
  }


  const now = Math.floor(Date.now() / 1000);
  const previous = live ? live.rows.get(node.username) : await env.DB.prepare(
    "SELECT metrics_json, traffic_period, traffic_base_in, traffic_base_out FROM agent_metrics WHERE username = ?"
  ).bind(node.username).first();
  const rx = Math.max(0, Number(body.metrics.network_in) || 0);
  const tx = Math.max(0, Number(body.metrics.network_out) || 0);
  const period = trafficPeriod(now, node.monthstart);
  let baseIn = previous ? Number(previous.traffic_base_in) || 0 : rx;
  let baseOut = previous ? Number(previous.traffic_base_out) || 0 : tx;
  if (!previous || previous.traffic_period !== period || rx < baseIn || tx < baseOut) {
    baseIn = rx;
    baseOut = tx;
  }

  const oldMetrics = previous ? JSON.parse(previous.metrics_json) : {};
  const samePeriod = previous && previous.traffic_period === period;
  function accumulate(counter, oldCounter, total, baseline) {
    if (!samePeriod) return 0;
    const prior = Number(oldCounter) || 0;
    const carried = total === undefined ? Math.max(0, prior - baseline) : Number(total) || 0;
    return carried + (counter >= prior ? counter - prior : counter);
  }
  const monthlyIn = accumulate(rx, oldMetrics.network_in, oldMetrics.monthly_network_in, Number(previous?.traffic_base_in) || 0);
  const monthlyOut = accumulate(tx, oldMetrics.network_out, oldMetrics.monthly_network_out, Number(previous?.traffic_base_out) || 0);
  const metrics = Object.fromEntries(Object.entries(body.metrics).filter(([key]) => AGENT_METRIC_FIELDS.has(key)));
  metrics.monthly_network_in = monthlyIn;
  metrics.monthly_network_out = monthlyOut;
  metrics.tcp_count = Number(metrics.tcp_count ?? metrics.tcp) || 0;
  metrics.udp_count = Number(metrics.udp_count ?? metrics.udp) || 0;
  metrics.process_count = Number(metrics.process_count ?? metrics.process) || 0;
  metrics.thread_count = Number(metrics.thread_count ?? metrics.thread) || 0;
  const row = { username: node.username, metrics_json: JSON.stringify(metrics), last_seen: now,
    traffic_period: period, traffic_base_in: baseIn, traffic_base_out: baseOut };
  if (live) {
    live.rows.set(node.username, row);
    live.dirty.add(node.username);
  } else if (!(await saveMetric(env, row, node.password))) {
    return json({ error: "Node credentials changed; refresh Agent configuration" }, 401);
  }
  return json({ ok: true, received_at: now });
}

async function saveMetric(env, row, password) {
  const saved = await env.DB.prepare(
    `INSERT INTO agent_metrics (username, metrics_json, last_seen, traffic_period, traffic_base_in, traffic_base_out)
     SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS
       (SELECT 1 FROM json_each((SELECT config_json FROM app_config WHERE id = 1), '$.servers')
        WHERE json_extract(value, '$.username') = ? AND json_extract(value, '$.password') = ?)
     ON CONFLICT(username) DO UPDATE SET metrics_json=excluded.metrics_json, last_seen=excluded.last_seen,
       traffic_period=excluded.traffic_period, traffic_base_in=excluded.traffic_base_in, traffic_base_out=excluded.traffic_base_out`
  ).bind(row.username, row.metrics_json, row.last_seen, row.traffic_period, row.traffic_base_in,
    row.traffic_base_out, row.username, password).run();
  return saved.meta?.changes === 1;
}

async function stats(env, live = null) {
  const [configRow, metricRows] = live ? [live.config, { results: [...live.rows.values()] }] : await Promise.all([
    getConfig(env),
    env.DB.prepare("SELECT username, metrics_json, last_seen, traffic_period, traffic_base_in, traffic_base_out FROM agent_metrics").all(),
  ]);
  if (!configRow) return json({ updated: Math.floor(Date.now() / 1000), servers: [] });
  const metricByUser = new Map((metricRows.results || []).map((row) => [row.username, row]));
  const now = Math.floor(Date.now() / 1000);
  const servers = JSON.parse(configRow.config_json).servers.map((node) => {
    const row = metricByUser.get(node.username);
    const metrics = row ? JSON.parse(row.metrics_json) : {};
    const online = !!row && now - Number(row.last_seen) <= OFFLINE_AFTER_SECONDS;
    const publicFields = new Set(["name", "username", "host", "type", "location", "monthstart", "hidden"]);
    const publicNode = Object.fromEntries(Object.entries(node).filter(([key]) => publicFields.has(key)));
    return {
      ...metrics,
      ...publicNode,
      monthly_network_in: row && row.traffic_period === trafficPeriod(now, node.monthstart) ? Number(metrics.monthly_network_in) || 0 : 0,
      monthly_network_out: row && row.traffic_period === trafficPeriod(now, node.monthstart) ? Number(metrics.monthly_network_out) || 0 : 0,
      online4: online && !!metrics.online4,
      online6: online && !!metrics.online6,
      last_seen: row ? Number(row.last_seen) : 0,
      last_network_in: row ? Number(row.traffic_base_in) || 0 : 0,
      last_network_out: row ? Number(row.traffic_base_out) || 0 : 0,
    };
  });
  return json({ updated: now, servers });
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char]);
}

async function sendTelegram(env, message) {
  if (!env.TG_BOT_TOKEN || !env.TG_CHAT_ID) return;
  const response = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: env.TG_CHAT_ID, text: message, parse_mode: "HTML", disable_web_page_preview: true }),
  });
  if (!response.ok || !(await response.json()).ok) throw new Error("Telegram notification failed");
}

async function staticAsset(request, env) {
  const response = await env.ASSETS.fetch(request);
  if (!response.ok) return response;
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-cache, must-revalidate");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function scheduled(env, live = null) {
  const [configRow, metricRows, states] = await Promise.all([
    live ? live.config : getConfig(env),
    live ? { results: [...live.rows.values()] } : env.DB.prepare("SELECT username, last_seen FROM agent_metrics").all(),
    env.DB.prepare("SELECT username, is_online FROM notification_state").all(),
  ]);
  if (!configRow) return;
  const now = Math.floor(Date.now() / 1000);
  const metrics = new Map((metricRows.results || []).map((row) => [row.username, row]));
  const previous = new Map((states.results || []).map((row) => [row.username, Number(row.is_online) === 1]));
  const changes = [];
  const updates = [];
  const nodes = JSON.parse(configRow.config_json).servers;
  const currentUsers = new Set(nodes.map((node) => node.username));
  for (const node of nodes) {
    const metric = metrics.get(node.username);
    const online = !!metric && now - Number(metric.last_seen) <= OFFLINE_AFTER_SECONDS;
    if (!previous.has(node.username)) {
      await env.DB.prepare("INSERT OR REPLACE INTO notification_state (username, is_online, updated_at) VALUES (?, ?, ?)")
        .bind(node.username, online ? 1 : 0, now).run();
      continue;
    }
    if (previous.get(node.username) !== online) {
      updates.push(env.DB.prepare("UPDATE notification_state SET is_online = ?, updated_at = ? WHERE username = ?")
        .bind(online ? 1 : 0, now, node.username));
      changes.push(`${online ? "✅ 主机上线：" : "🔴 主机下线："}${escapeHtml(node.name)}`);
    }
  }
  for (const username of previous.keys()) {
    if (!currentUsers.has(username)) {
      await env.DB.prepare("DELETE FROM notification_state WHERE username = ?").bind(username).run();
    }
  }
  if (changes.length) {
    await sendTelegram(env, `<b>CF Server Status</b>\n${changes.join("\n")}`);
    for (const update of updates) await update.run();
  }
}

// One hub for this deployment. All mutations, including legacy HTTP reports, are
// serialized here so a checkpoint cannot overwrite a newer report/configuration.
export class RealtimeHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.rows = new Map();
    this.dirty = new Set();
    this.queue = Promise.resolve();
    if (typeof WebSocketRequestResponsePair !== 'undefined') {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }
    this.activeInterval = [1, 3].includes(Number(env.SSS_REALTIME_INTERVAL)) ? Number(env.SSS_REALTIME_INTERVAL) : 1;
    ctx.blockConcurrencyWhile(async () => {
      this.config = await getConfig(env);
      const saved = await env.DB.prepare("SELECT * FROM agent_metrics").all();
      this.rows = new Map((saved.results || []).map(row => [row.username, row]));
      // Attachments survive hibernation; D1 is the restart/deployment checkpoint.
      for (const ws of ctx.getWebSockets('agent')) {
        const a = ws.deserializeAttachment();
        const node = this.nodes().find(n => n.username === a?.username && safeEqual(n.password, a.password));
        if (!node) { ws.close(1008, 'Credentials changed'); continue; }
        if (a.row && a.row.last_seen >= (this.rows.get(a.username)?.last_seen || 0)) {
          this.rows.set(a.username, a.row);
          this.dirty.add(a.username);
        }
      }
    });
  }
  nodes() { return JSON.parse(this.config?.config_json || '{"servers":[]}').servers; }
  serial(fn) {
    const pending = this.queue.then(fn);
    this.queue = pending.catch(() => {});
    return pending;
  }
  viewers() { return this.ctx.getWebSockets('viewer').filter(ws => ws.readyState === 1); }
  interval() { return this.viewers().length ? this.activeInterval : 60; }
  send(ws, data) {
    try { ws.send(JSON.stringify(data)); } catch { try { ws.close(1011, 'Reconnect'); } catch {} }
  }
  hint() {
    for (const ws of this.ctx.getWebSockets('agent')) this.send(ws, { type: 'interval', seconds: this.interval() });
  }
  async snapshot() { return (await stats(this.env, this)).json(); }
  async broadcast() {
    const viewers = this.viewers();
    if (!viewers.length) return;
    const data = { type: 'stats', ...await this.snapshot() };
    for (const ws of viewers) this.send(ws, data);
  }
  async flush(users = this.dirty) {
    for (const username of [...users]) {
      const node = this.nodes().find(n => n.username === username);
      const row = this.rows.get(username);
      if (node && row) await saveMetric(this.env, row, node.password);
      this.dirty.delete(username);
    }
  }
  async fetch(request) {
    // Consume the incoming stream in its own request context before queuing.
    // Cross-request promise chains must never retain a previous request's I/O.
    let body;
    if (request.body) {
      try { body = await readBody(request, MAX_CONFIG_BYTES); }
      catch { return text('Request body is too large', 413); }
    }
    const url = request.url, method = request.method, headers = new Headers(request.headers);
    return this.serial(() => this.handle(new Request(url, { method, headers, body })));
  }
  async handle(request) {
    const path = new URL(request.url).pathname;
    if (path === '/scheduled') { await this.flush(); await scheduled(this.env, this); await this.broadcast(); return json({ ok: true }); }
    if (path === '/api/admin/config') {
      const candidate = request.method === 'PUT' ? request.clone() : null;
      const response = await adminConfig(request, this.env);
      if (response.ok && candidate) {
        const accepted = await candidate.json();
        const { revision } = await response.clone().json();
        this.config = { revision, config_json: JSON.stringify(accepted.config), updated_at: Math.floor(Date.now() / 1000) };
        const users = new Set(this.nodes().map(n => n.username));
        for (const username of this.rows.keys()) if (!users.has(username)) {
          this.rows.delete(username); this.dirty.delete(username);
        }
        for (const ws of this.ctx.getWebSockets('agent')) {
          const a = ws.deserializeAttachment();
          if (!this.nodes().some(n => n.username === a.username && safeEqual(n.password, a.password))) ws.close(1008, 'Credentials changed');
        }
        await this.broadcast();
      }
      return response;
    }
    if (path === '/api/agent/report') {
      const response = await report(request.clone(), this.env, this);
      if (response.ok) {
        // Do not flush every WSS node whenever one legacy agent reports.
        await this.flush([(await request.json()).username]);
        await this.broadcast();
      }
      return response;
    }
    if (path === '/json/stats.json') return request.method === 'GET' ? stats(this.env, this) : text('Method not allowed', 405);
    if (!['/api/agent/ws', '/api/live'].includes(path)) return text('Not found', 404);
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return text('WebSocket required', 426);
    const viewer = path === '/api/live';
    const origin = request.headers.get('origin');
    if (viewer && origin && origin !== new URL(request.url).origin) return text('Forbidden origin', 403);
    let attachment = { role: 'viewer' };
    if (!viewer) {
      const username = request.headers.get('x-agent-user');
      const password = bearer(request);
      const node = this.nodes().find(n => n.username === username && safeEqual(n.password, password));
      if (!node) return text('Invalid credentials', 401);
      attachment = { role: 'agent', username, password };
      if (new TextEncoder().encode(JSON.stringify(attachment)).length > 512) return text('Credentials too long for realtime transport', 413);
      for (const old of this.ctx.getWebSockets('agent')) {
        if (old.deserializeAttachment()?.username === username) old.close(1000, 'Replaced by new connection');
      }
    } else if (this.viewers().length >= 100) return text('Too many viewers', 429);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [viewer ? 'viewer' : 'agent']);
    server.serializeAttachment(attachment);
    if (viewer) { this.send(server, { type: 'stats', ...await this.snapshot() }); this.hint(); }
    else this.send(server, { type: 'interval', seconds: this.interval() });
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws, message) {
    return this.serial(async () => {
      const a = ws.deserializeAttachment();
      if (a?.role !== 'agent') { ws.close(1008, 'Read only'); return; }
      if (typeof message !== 'string' || new TextEncoder().encode(message).length > MAX_REPORT_BYTES) {
        ws.close(1009, 'Report too large'); return;
      }
      let payload;
      try { payload = JSON.parse(message); } catch { ws.close(1008, 'Invalid JSON'); return; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { ws.close(1008, 'Invalid report'); return; }
      const response = await report(new Request('https://internal/api/agent/report', {
        method: 'POST', body: JSON.stringify({ username: a.username, password: a.password, metrics: payload.metrics })
      }), this.env, this);
      if (!response.ok) { ws.close(1008, 'Invalid report or credentials'); return; }
      const row = this.rows.get(a.username);
      ws.serializeAttachment({ ...a, row });
      this.send(ws, { type: 'ack', seconds: this.interval(), received_at: row.last_seen });
      await this.broadcast();
    });
  }
  webSocketClose(ws) { return this.serial(async () => { try { ws.close(); } catch {} this.hint(); }); }
  webSocketError(ws) { try { ws.close(1011, 'Reconnect'); } catch {} }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/health" && request.method === "GET") return json({ ok: true });
      if (env.REALTIME && ['/api/admin/config', '/api/agent/report', '/api/agent/ws', '/api/live', '/json/stats.json'].includes(url.pathname)) {
        let forwarded = request;
        if (request.body) {
          let body;
          try { body = await readBody(request, MAX_CONFIG_BYTES); }
          catch { return text('Request body is too large', 413); }
          forwarded = new Request(request.url, { method: request.method, headers: request.headers, body });
        }
        return await env.REALTIME.get(env.REALTIME.idFromName('global')).fetch(forwarded);
      }
      if (url.pathname === "/api/admin/config") return await adminConfig(request, env);
      if (url.pathname === "/api/agent/report") return await report(request, env);
      if (url.pathname === "/json/stats.json" && request.method === "GET") return await stats(env);
      return await staticAsset(request, env);
    } catch (error) {
      console.error("request failed", error?.name || 'Error');
      return json({ error: "Internal server error" }, 500);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(env.REALTIME ? env.REALTIME.get(env.REALTIME.idFromName('global')).fetch(new Request('https://internal/scheduled', { method: 'POST' })).then(r => { if (!r.ok) throw new Error('Scheduled check failed'); }) : scheduled(env));
  },
};
