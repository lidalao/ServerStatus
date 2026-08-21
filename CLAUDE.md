# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A management/notification add-on for cppla's [ServerStatus](https://github.com/cppla/ServerStatus) probe. It does **not** modify upstream ServerStatus server code; it wraps the upstream Docker image with node CRUD tooling, a Telegram up/down notifier, a vendored modern web frontend, and systemd-based agent installation. CLI text/prompts are in Chinese ("jj"/"MJJ" are slang for VPS servers); the **web UI is English-only**.

## Layout

```
sss.sh                 # 服务端入口: 安装面板 + 交互式节点管理(纯 bash + jq, 无 python 依赖)
docker-compose.yml     # 编排(project name=sss): srv + web + bot -> 容器 sss-srv-1 / sss-web-1 / sss-bot-1
service/
  bot/{bot.py,Dockerfile}            # Telegram 上下线通知 bot(build)
  web/{index.html,css/app.css,js/app.js,favicon.svg,Dockerfile}  # 自建前端(照搬 tz.huilang.me 配色 + monitor.seaya.link 系统字体栈), build 进 nginx 镜像
agent/{client-linux.py,sss-agent.sh,sss-agent.service}  # 被监控机器侧
```

## Architecture

Three roles communicate through the upstream ServerStatus server, run unmodified as the `cppla/serverstatus:latest` Docker image:

- **Server side (panel host)** — `docker-compose.yml` (project `name: sss`) runs three services, auto-named `sss-srv-1` / `sss-web-1` / `sss-bot-1` (no `container_name`): **`srv`** (upstream `cppla/serverstatus`, TCP report port `35601`) receives agent uploads and writes `json/stats.json`; **`web`** (nginx, frontend baked into the image via `service/web/Dockerfile`) serves the dashboard on `8081` and reads the shared `./json` mounted read-only at the `json/` subpath; **`bot`** (built from `service/bot/`) sends Telegram notifications. `config.json` (`{"servers":[...]}`) is bind-mounted into `srv` and is the single source of truth for which nodes exist. `srv` and `web` share the host `./json` directory — srv writes, web reads.
- **Node management** — implemented **directly in `sss.sh`** (bash + `jq`); there is no `_sss.py` anymore. **`sss.sh` does node CRUD only — it never installs docker, never builds, never starts the stack.** `pre_check` just verifies root + `jq` + `docker` + being inside the repo; `menu_loop` warns (via `stack_running`) and prints `docker compose up -d --build` if `srv` isn't up, but never runs it. The menu does view/add/remove/update against `config.json` via `jq` (atomic temp-file + `mv` writes, `sort_by(.name)`), then `dc restart srv` — only `srv` reads `config.json`. Menu `1. 查看节点` (`view_node`/`show_node_detail`) prints a node's location/type/monthstart/username/password **and re-prints its agent install command** (blank input = all nodes); any unrecognised input exits (no "press 0 to quit" loop). `ensure_config` also errors out if `config.json` is a *directory* — what docker creates when the bind-mount source is missing. Each added node gets a random `username` (`/proc/sys/kernel/random/uuid`) + `password` (`/dev/urandom`, ≥1 digit/lower/upper); `print_agent_cmd` prints the exact `agent/sss-agent.sh` install command.
- **Agent side (monitored machines)** — `agent/client-linux.py` (upstream cppla collector, only modification: `tupd()` stubbed to return zeros) connects to the panel's `35601` and authenticates with the node's USER/PASSWORD, streaming metrics. Installed as a systemd service via `agent/sss-agent.sh`.

`service/bot/bot.py` polls `http://srv/json/stats.json` (the `srv` service hostname on the compose network — auto-named container `sss-srv-1`) every 3s and sends Telegram messages on state changes. **Debounce:** a node must report the same state for 10 consecutive polls (`counterOn`/`counterOff`) before a message fires — suppresses flapping. State is in-memory only.

### Web frontend (`service/web`)
Vanilla HTML/CSS/JS (no JS bundler); packaged into the `web` nginx image via `service/web/Dockerfile`. `js/app.js` fetches `json/stats.json?_=<ts>` every 1.5s and re-renders the `<tbody>`. Clicking a row toggles an **inline accordion detail row** (old-site `tz.lidalao.com` style, not a modal): `Network ↓|↑` / `Memory|Swap` / `Disk|IO` / `TCP·UDP·Proc·Thread` / `CU·CT·CM`; expanded state (`S.expanded`) survives re-renders, offline rows don't expand. Column widths are **auto** (content-sized) — except **NETWORK** (`.c-net`, the live rx/tx rate) which is pinned to a fixed width so its frequently-changing values don't jitter the whole table. Responsive: at ≤920px the secondary columns hide, at ≤640px only 协议/节点/负载/CPU/内存/硬盘 remain — NETWORK is also hidden and surfaced in the accordion detail instead (see `nth-child` rules), matching `ref/mobile.png`. Keeps the *original* cppla column set but with **English headers** (PROTOCOL/MONTHLY/NAME/TYPE/REGION/UPTIME/LOAD/NETWORK/TRAFFIC/CPU/RAM/DISK/CU·CT·CM), country-flag regions, status dots, thin bars. The CU/CT/CM cells show **packet-loss % on top + latency `ms` below** so loss is visible without expanding (`pingCell`); 0-loss renders uniform-dim, only mid/bad loss is colored (calm). **The whole palette + look is ported 1:1 from `tz.huilang.me` (terminal aesthetic):** light = its `body.light` (`--bg-1: #f5f5f0` uniform warm-cream page, item bg `rgba(232,232,224,.6)`, header `rgba(250,250,245,.6)`, hover `rgba(240,240,232,.6)`, text `#2c2c2c`, accents blue/green/purple/cyan/amber/red), dark = its `:root` (`#0a0e14` …); flat, 4px radius, **no zebra striping**. Fonts are **system-only, no web font loaded** (copied from `monitor.seaya.link`): `--sans` = system sans stack (`-apple-system, "Segoe UI", Roboto, …, system-ui, sans-serif`) used for UI/body, `--mono` = system mono stack (`ui-monospace, SFMono-Regular, Menlo, …`) used for numeric/metric cells (`.duo2`/`.ping`/gauges/`.mono`). (Earlier the whole UI was monospace JetBrains Mono — that was reverted.) The **"条纹" is a full-viewport CRT scanline overlay** (`body::before`, fixed, `repeating-linear-gradient` via `--scanline`: light `.015` / dark `.03`) covering the entire page, **not** row striping. Progress-bar columns (CPU/RAM/DISK) animate: the `<tbody>` is updated **in place** when the node set is unchanged (`sameRowSet`/`updateRows`) so each bar `<i>` persists and its `width` CSS-transitions on value change; freshly created bars grow from 0 via `flushNewBars()` on the next frame. Theme switcher is **light / dark / system** persisted in `localStorage['theme']`; `system` follows `prefers-color-scheme` live, applied via `data-theme` on `<html>` (a head bootstrap script sets it pre-paint to avoid flash). Field schema consumed is the upstream `stats.json` (`online4/6`, `network_in/out`, `last_network_in/out`, `memory_*`, `hdd_*`, `cpu`, `load_1`, `ping_*`, `time_*`, …).

## Config / credential flow

No app-level config is checked in. **The panel host runs from a `git clone` of this repo**, and **deployment is plain docker**: `cp .env.sample .env` + `echo '{"servers":[]}' > config.json` + `docker compose up -d --build` installs, `git pull && docker compose up -d --build` updates (`service/web` and `service/bot` are the compose *build contexts*, so `--build` is what ships frontend changes). `sss.sh` is **not** part of that path — it only manages nodes.

- **TG credentials live in `.env`** (`TG_CHAT_ID` / `TG_BOT_TOKEN`); `docker-compose.yml` only references `${TG_CHAT_ID:-}` / `${TG_BOT_TOKEN:-}`, so no tracked file is ever `sed`-mutated and `git pull` stays conflict-free. `.env.sample` documents every key.
- **Ports live in `.env`** too: `WEB_PORT` (default 8081) and `REPORT_PORT` (default 35601) feed `${WEB_PORT:-8081}:80` / `${REPORT_PORT:-35601}:35601`. **`REPORT_PORT` is a host-port remap only** — the container still listens on 35601, `print_agent_cmd` does not emit a port, and `agent/sss-agent.sh` takes exactly 3 args, so a non-default value means every agent needs ` PORT=<port>` appended to its unit's `ExecStart` by hand (`client-linux.py` parses `PORT=` from argv). `.env.sample` says: only change it before any agent is connected.
- `.env`, `config.json` and `json/` are gitignored (runtime state on the panel host). `config.json` must exist **before** the first `up` — docker turns a missing bind-mount source into a directory.
- `dc()` wraps compose: prefers `docker compose` (v2 plugin), falls back to `docker-compose` (v1).
- **Cache headers:** `service/web/nginx.conf` (COPYed to `conf.d/default.conf`, validated by `RUN nginx -t` at build) sends `Cache-Control: no-cache, must-revalidate` for the page/CSS/JS and `no-store` for `/json/`. Without it Cloudflare pins the fixed-URL `js/app.js` and frontend updates appear not to deploy; `stats.json` was unaffected because `app.js` fetches it with `?_=<ts>`. Already-cached copies still need one manual purge.
- **Agents still bootstrap over HTTP:** `agent/sss-agent.sh` downloads `client-linux.py` to `/opt/sss/agent/` and replaces `sss_host` / `sss_user` / `sss_pass` in `sss-agent.service` before enabling it. It and `print_agent_cmd` fetch from `GITHUB_RAW_URL` (`raw.githubusercontent.com/lidalao/ServerStatus/master`) **at runtime**, so for the agent side `master` is still the release channel and moving `agent/*` requires updating those raw URLs.

## Running / testing

No build system, lint, or test suite. Host needs **`jq`** + **`git`** (and docker/compose); **no python on the host** — `bot.py` runs in its container, `client-linux.py` runs on agents.

```bash
# 服务端首次安装: 需要 docker; 面板本身完全由 compose 驱动
git clone https://github.com/lidalao/ServerStatus.git sss && cd sss
cp .env.sample .env && vi .env            # TG_CHAT_ID / TG_BOT_TOKEN / WEB_PORT
echo '{"servers":[]}' > config.json       # 必须先建, 否则 docker 建成目录
docker compose up -d --build
# 更新: 拉代码 + 重建镜像
git pull && docker compose up -d --build
# 节点增删改查(需要 jq): 只改 config.json + restart srv, 不碰 docker 其余部分
sudo ./sss.sh

docker compose logs -f bot        # watch Telegram notifier

# 本地预览前端(造样例数据):
mkdir -p /tmp/prev/json && cp -r service/web/* /tmp/prev/
echo '{"updated":'$(date +%s)',"servers":[]}' > /tmp/prev/json/stats.json
(cd /tmp/prev && python3 -m http.server 8099)   # 打开 http://localhost:8099

# Agent 端手动运行采集器(平时由 systemd 跑)
python3 agent/client-linux.py SERVER=<panel_ip> USER=<node_user> PASSWORD=<node_pass>
```

`service/bot/bot.py` depends on `requests` (in-container); `agent/client-linux.py` is stdlib-only (Python 2.7–3.9).
