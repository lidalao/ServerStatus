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
  web/{index.html,css/app.css,js/app.js,favicon.svg,Dockerfile}  # 自建前端(照搬 tz.huilang.me 终端风配色, 等宽字体), build 进 nginx 镜像
agent/{client-linux.py,sss-agent.sh,sss-agent.service}  # 被监控机器侧
```

## Architecture

Three roles communicate through the upstream ServerStatus server, run unmodified as the `cppla/serverstatus:latest` Docker image:

- **Server side (panel host)** — `docker-compose.yml` (project `name: sss`) runs three services, auto-named `sss-srv-1` / `sss-web-1` / `sss-bot-1` (no `container_name`): **`srv`** (upstream `cppla/serverstatus`, TCP report port `35601`) receives agent uploads and writes `json/stats.json`; **`web`** (nginx, frontend baked into the image via `service/web/Dockerfile`) serves the dashboard on `8081` and reads the shared `./json` mounted read-only at the `json/` subpath; **`bot`** (built from `service/bot/`) sends Telegram notifications. `config.json` (`{"servers":[...]}`) is bind-mounted into `srv` and is the single source of truth for which nodes exist. `srv` and `web` share the host `./json` directory — srv writes, web reads.
- **Node management** — implemented **directly in `sss.sh`** (bash + `jq`); there is no `_sss.py` anymore. The menu (`menu_loop`) does view/add/remove/update against `config.json` via `jq` (atomic temp-file + `mv` writes, `sort_by(.name)`), then `docker-compose restart` to reload. Each added node gets a random `username` (`/proc/sys/kernel/random/uuid`) + `password` (`/dev/urandom`, ≥1 digit/lower/upper); `print_agent_cmd` prints the exact `agent/sss-agent.sh` install command.
- **Agent side (monitored machines)** — `agent/client-linux.py` (upstream cppla collector, only modification: `tupd()` stubbed to return zeros) connects to the panel's `35601` and authenticates with the node's USER/PASSWORD, streaming metrics. Installed as a systemd service via `agent/sss-agent.sh`.

`service/bot/bot.py` polls `http://srv/json/stats.json` (the `srv` service hostname on the compose network — auto-named container `sss-srv-1`) every 3s and sends Telegram messages on state changes. **Debounce:** a node must report the same state for 10 consecutive polls (`counterOn`/`counterOff`) before a message fires — suppresses flapping. State is in-memory only.

### Web frontend (`service/web`)
Vanilla HTML/CSS/JS (no JS bundler); packaged into the `web` nginx image via `service/web/Dockerfile`. `js/app.js` fetches `json/stats.json?_=<ts>` every 1.5s and re-renders the `<tbody>`. Clicking a row toggles an **inline accordion detail row** (old-site `tz.lidalao.com` style, not a modal): `Network ↓|↑` / `Memory|Swap` / `Disk|IO` / `TCP·UDP·Proc·Thread` / `CU·CT·CM`; expanded state (`S.expanded`) survives re-renders, offline rows don't expand. Column widths are **auto** (content-sized) — except **NETWORK** (`.c-net`, the live rx/tx rate) which is pinned to a fixed width so its frequently-changing values don't jitter the whole table. Responsive: at ≤920px the secondary columns hide, at ≤640px only 协议/节点/负载/CPU/内存/硬盘 remain — NETWORK is also hidden and surfaced in the accordion detail instead (see `nth-child` rules), matching `ref/mobile.png`. Keeps the *original* cppla column set but with **English headers** (PROTOCOL/MONTHLY/NAME/TYPE/REGION/UPTIME/LOAD/NETWORK/TRAFFIC/CPU/RAM/DISK/CU·CT·CM), country-flag regions, status dots, thin bars. The CU/CT/CM cells show **packet-loss % on top + latency `ms` below** so loss is visible without expanding (`pingCell`); 0-loss renders uniform-dim, only mid/bad loss is colored (calm). **The whole palette + look is ported 1:1 from `tz.huilang.me` (terminal aesthetic):** light = its `body.light` (`--bg-1: #f5f5f0` uniform warm-cream page, item bg `rgba(232,232,224,.6)`, header `rgba(250,250,245,.6)`, hover `rgba(240,240,232,.6)`, text `#2c2c2c`, accents blue/green/purple/cyan/amber/red), dark = its `:root` (`#0a0e14` …); flat, 4px radius, **no zebra striping**. Fonts are **monospace only** (`--mono: "JetBrains Mono", ui-monospace…`; `--sans` aliases `--mono`) — JetBrains Mono is *not* bundled, falls back to system mono. The **"条纹" is a full-viewport CRT scanline overlay** (`body::before`, fixed, `repeating-linear-gradient` via `--scanline`: light `.015` / dark `.03`) covering the entire page, **not** row striping. Progress-bar columns (CPU/RAM/DISK) animate: the `<tbody>` is updated **in place** when the node set is unchanged (`sameRowSet`/`updateRows`) so each bar `<i>` persists and its `width` CSS-transitions on value change; freshly created bars grow from 0 via `flushNewBars()` on the next frame. Theme switcher is **light / dark / system** persisted in `localStorage['theme']`; `system` follows `prefers-color-scheme` live, applied via `data-theme` on `<html>` (a head bootstrap script sets it pre-paint to avoid flash). Field schema consumed is the upstream `stats.json` (`online4/6`, `network_in/out`, `last_network_in/out`, `memory_*`, `hdd_*`, `cpu`, `load_1`, `ping_*`, `time_*`, …).

## Config / credential flow

No app-level config is checked in. Values are injected by the shell installers via `sed` placeholder replacement:

- `sss.sh` replaces `tg_chat_id` / `tg_bot_token` in `docker-compose.yml` (bot reads them as `TG_CHAT_ID` / `TG_BOT_TOKEN`).
- `agent/sss-agent.sh` downloads `client-linux.py` to `/opt/sss/agent/` and replaces `sss_host` / `sss_user` / `sss_pass` in `sss-agent.service` before enabling it.

Both scripts `wget` files from `GITHUB_RAW_URL` (`raw.githubusercontent.com/lidalao/ServerStatus/master`) **at runtime**, so the repo's `master` branch is the release channel — local edits only take effect once pushed there. **Paths matter:** `sss.sh` fetches `service/bot/*` and `service/web/*`; `agent/sss-agent.sh` fetches `agent/client-linux.py` and `agent/sss-agent.service`. Moving any of these requires updating the matching raw URLs.

## Running / testing

No build system, lint, or test suite. Host needs **`jq`** (and docker/docker-compose); **no python on the host** — `bot.py` runs in its container, `client-linux.py` runs on agents.

```bash
# 服务端首次安装(带 TG 参数): 装 docker/jq, 拉 service/*, 起栈, 进节点管理菜单
sudo ./sss.sh <TG_CHAT_ID> <TG_BOT_TOKEN>
# 之后再次运行(栈已起): 直接进节点管理菜单
sudo ./sss.sh

docker-compose up -d
docker-compose logs -f bot        # watch Telegram notifier

# 本地预览前端(造样例数据):
mkdir -p /tmp/prev/json && cp -r service/web/* /tmp/prev/
echo '{"updated":'$(date +%s)',"servers":[]}' > /tmp/prev/json/stats.json
(cd /tmp/prev && python3 -m http.server 8099)   # 打开 http://localhost:8099

# Agent 端手动运行采集器(平时由 systemd 跑)
python3 agent/client-linux.py SERVER=<panel_ip> USER=<node_user> PASSWORD=<node_pass>
```

`service/bot/bot.py` depends on `requests` (in-container); `agent/client-linux.py` is stdlib-only (Python 2.7–3.9).
