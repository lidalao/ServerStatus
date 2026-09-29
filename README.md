# ServerStatus

本分支只使用 Cloudflare Workers + D1：Web、API 和通知任务跑在 CF；Linux VPS 运行 Python HTTPS Agent；管理机器通过 `sss.sh` 操作节点。没有 Docker 或自托管后端。

## 一个配置文件，一个入口

运行 `bash ./sss.sh help` 查看完整命令、配置项、节点菜单与使用示例；也支持 `--help` 和 `-h`。

```bash
bash ./sss.sh init
# 编辑刚生成的 .env
bash ./sss.sh deploy
bash ./sss.sh
```

`init` 生成权限为 600 的 `.env`，不会覆盖已有文件。也可以复制 `.env.sample`。默认读取 `sss.sh` 同目录的 `.env`；指定其他文件用 `SSS_ENV_FILE=/path/to/sss.env bash ./sss.sh`。环境变量优先于文件值。文件只支持单行 `KEY=VALUE`（可带一对引号），不执行 shell 命令、不展开变量、不支持行尾注释。

首次部署只需填写：

```dotenv
CLOUDFLARE_ACCOUNT_ID=你的账号ID
CLOUDFLARE_API_TOKEN=你的API Token
```

Token 应针对目标账号具备 Workers Scripts 编辑、D1 编辑、Workers Account Settings 读取权限；脚本使用 Token，不需要 `wrangler login`。账号首次使用 Workers 时，需要先启用 workers.dev 子域名。CF Token 用于部署，与节点管理 Token 不同。

其他配置都在同一个文件：

| 配置 | 用途 |
| --- | --- |
| `SSS_WORKER_NAME` | Worker 名称，默认 `sss-server-status` |
| `SSS_D1_NAME` | D1 名称，默认 `sss-server-status` |
| `SSS_D1_ID` | 自动查找或创建 D1 后写回 |
| `SSS_MANAGEMENT_TOKEN` | 首次自动生成并保存；已有部署必须保留原值 |
| `SSS_WORKER_URL` | 部署后自动写回 workers.dev 地址；已有自定义域名可填入 |
| `TG_BOT_TOKEN` / `TG_CHAT_ID` | 可选通知，两项同时填写；留空关闭通知 |
| `GITHUB_RAW_URL` | CLI/Agent 发布来源，默认本分支 |

## 部署和更新

部署机器需要 Node.js 22+、npm。源码目录内运行 `bash ./sss.sh deploy` 会发布当前源码；单独下载的 `sss.sh` 会先从配置的 GitHub 分支/标签下载完整源码（需要 curl 和 tar）。CLI 和 Agent 的 GitHub 下载源必须已发布，部署 CF 不会替你 commit/push GitHub。

`deploy` 用于部署，`update` 用于已有服务更新；更新要求已保存 D1 ID、Worker URL 与管理 Token。脚本自动安装锁定的 Wrangler 依赖、检查 Worker 构建、查找/创建 D1、应用远端迁移、发布 Web/API/Secrets、验证管理 API，并将数据库 ID、管理 Token、地址写回 `.env`。再次运行会复用数据库与 Token，不清空节点。临时 Secrets 文件会在成功或失败后移除；发生失败时已生成的凭据和 D1 ID 保留，方便重试。

```bash
bash ./sss.sh deploy --plan  # 只看步骤，不联网、不写入、不部署
bash ./sss.sh deploy        # 首次部署
bash ./sss.sh update        # 更新已有部署
```

默认交互菜单只包含节点管理。更新已部署服务使用 `bash ./sss.sh update`；首次部署使用 `deploy`。保留 `--init`、`--deploy`、`--update` 作为别名。部署配置从 `.env` 自动生成到忽略的 `.wrangler/` 内，不必再编辑 `wrangler.toml`。部署流程使用固定版本 Wrangler，暂未迁移 cf beta CLI。

## 节点管理和 VPS Agent

支持的入口如下，默认运行都只管理节点：

| 系统 | 入口 | 管理依赖 |
| --- | --- | --- |
| macOS | `bash ./sss.sh` | 系统 Bash、curl；`brew install jq` |
| Ubuntu / Debian | `bash ./sss.sh` | Bash、curl、jq（发行版包管理器安装） |
CF 部署和更新需要 Node.js 22+ 和 npm；日常节点管理不需要 Node.js。本分支支持 macOS、Ubuntu 和 Debian。

把以下两项放在管理机 `.env` 即可，不需要 CF API Token 或 CF 登录：

```dotenv
SSS_WORKER_URL=https://你的Worker地址
SSS_MANAGEMENT_TOKEN=部署机器.env中的管理Token
```

运行 `bash ./sss.sh`：菜单 **2** 添加、**3** 删除、**4** 修改、**5** 切换 Web 隐藏状态。编辑只改变本地草稿，菜单 **6** 提交到远端。提交使用 revision CAS，防止覆盖另一台管理机器的修改。

添加后先提交，再复制脚本打印的完整命令到 VPS，以普通用户执行。命令包含节点凭据和相同 GitHub 源；不需要 sudo 或 Docker。Agent 位于 `~/.local/share/sss/agent`，用户 service 位于 `~/.config/systemd/user/sss-agent.service`。

```bash
systemctl --user status sss-agent
journalctl --user -u sss-agent -n 50 --no-pager
```

Agent 每 15 秒上报。用户 manager 和注销/重启后存活取决于 VPS 主机策略，必要时主机管理员需启用 linger。Agent 的原生 `/proc` 采集和 systemd 生命周期需在实际 Linux VPS 验证。

删除节点并提交后，其上报会被拒绝；在 VPS 运行安装器菜单 **2** 可卸载服务。隐藏只影响网页展示，不停止上报或通知。安装器菜单 **1** 更新现有 Agent，保留凭据；下载失败不会破坏旧安装。安装器会将 GitHub 源保存在 Agent 目录内私有的 `.env`，后续更新复用该来源；显式设置 `GITHUB_RAW_URL` 可覆盖。下载后校验 Cloudflare 协议标记，旧 TCP Agent 不会替换当前 Agent。

## 无 CF 配置的本地测试

```bash
npm ci
npm run test:local
npm run smoke:local
```

冒烟环境打开 `http://127.0.0.1:8788`。另一终端启动管理：

```bash
SSS_WORKER_URL=http://127.0.0.1:8788 SSS_MANAGEMENT_TOKEN=local-test-token bash ./sss.sh
```

首次准备四个模拟节点：可见在线/离线、隐藏在线/离线。在线节点每 15 秒模拟上报。数据保存在 `.wrangler/manual-state`，重启保留修改。Ctrl+C 停止；停止后移除此目录可重置手动测试数据。可用 `SSS_SMOKE_PORT=8789 npm run smoke:local` 修改端口。

自动测试使用单独临时 D1/Worker，覆盖节点 CRUD、隐藏、并发版本冲突、Python 上报和资源加载；部署流程的 CF API/发布使用替身验证，生成的生产配置使用真实 Wrangler dry-run 编译。不会操作真实账号。Linux service 控制使用替身，不能代替实际 VPS 验证。

日常开发也可使用 `npm run db:migrate:local`、`npm run dev:local`（8787）。旧 `~/.config/sss/remote.env` 仅作为没有 `.env` 时的兼容读取来源。

[设计审计记录](cloudflare/DESIGN_AUDIT.md)包含月流量、通知交付和验证边界。

GitHub Actions 已配置 macOS、Ubuntu 22.04/24.04 的完整回归测试矩阵。本地 macOS 已验证 Bash 入口，其他系统以对应运行器结果为准；Debian 采用同一 Bash 实现，实际主机验收仍待完成。
