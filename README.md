# ServerStatus

本分支只使用 Cloudflare Workers + D1 + Durable Objects：Web、API、实时广播和通知任务跑在 CF；Linux VPS 运行 Python WSS Agent；管理机器通过 `sss.sh` 操作节点。没有 Docker 或自托管后端。

## 一个配置文件，一个入口

运行 `bash ./sss.sh help` 查看完整命令、配置项、节点菜单与使用示例；也支持 `--help` 和 `-h`。

```bash
bash ./sss.sh init
# 编辑刚生成的 .env
bash ./sss.sh deploy
bash ./sss.sh
```

`init` 自动补齐 curl、jq、Node.js 22+ 和 npm，再生成权限为 600 的 `.env`。已有配置不会覆盖，重复执行可补齐依赖。macOS 缺少 curl/jq 时使用已有 Homebrew；Ubuntu/Debian 使用 apt-get，普通用户可能需要 sudo 安装系统工具。缺少合适 Node.js/npm 时从 nodejs.org 下载 Node.js 22，校验 SHA-256 后安装到 `~/.local/share/sss/node`；后续脚本自动使用，不替换系统 Node.js、不改 shell 配置。也可以复制 `.env.sample`。默认读取 `sss.sh` 同目录的 `.env`；指定其他文件用 `SSS_ENV_FILE=/path/to/sss.env bash ./sss.sh`。环境变量优先于文件值。文件只支持单行 `KEY=VALUE`（可带一对引号），不执行 shell 命令、不展开变量、不支持行尾注释。

换机器继续管理：原管理机器先使用本版本执行一次 `bash ./sss.sh update`，建立恢复备份。然后在新 Mac/Ubuntu/Debian 上克隆本分支或下载 `sss.sh`，在相邻 `.env` 只填写 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`，运行 `bash ./sss.sh init`。缺少管理/数据库配置时，脚本通过 CF API 从私有备份读取原管理 Token、Worker 地址、D1 ID、TG 配置、下载源及当前频率，原子回写权限 600 的 `.env`。之后直接运行 `bash ./sss.sh` 管理节点，或 `bash ./sss.sh update` 更新现有服务。默认 Worker 为 `sss-server-status`；同账号多个部署时，另外填写 `SSS_WORKER_NAME` 选择目标。已有完整 `.env` 的重复 init 只补齐依赖，不覆盖本地编辑。第一次部署尚无备份时，会保留本地设置；旧部署没有备份时会报错，要求原机器先 update，不会重新生成管理 Token。

恢复备份保存在独立 D1 数据库 `sss-recovery-<Worker 名称摘要>`，占用一个额外数据库，不绑定到网页 Worker、不放进 Assets，也不新增公开恢复 API。只通过带 CF API Token 的 D1 API 读取；CF Account ID/API Token 本身不写入备份，换机器可以使用同账号的另一个具备相应权限的 Token。备份包含管理 Token 和 TG 配置，使用 Cloudflare 的传输/存储加密，但不是应用层端到端加密：账号管理员、拥有 D1 读取权限的人或被攻破的管理机仍可以读取。若需要防止这些主体读取，需要额外恢复密钥，无法保持只提供两项 CF 参数的流程。普通节点管理 Token 不具备读取备份的能力；浏览器仅接收公开指标。部署成功后的快照才更新；失败时本地 `.env` 保留，脚本会明确区分部署失败与备份失败。不要分享 `.env` 或提交到 Git。

多管理机同步：执行 `bash ./sss.sh sync` 拉取其他机器已发布的最新配置，会覆盖本地尚未发布的配置修改，但保留当前机器的 CF API 凭据。`.env` 中自动保存 `SSS_SETTINGS_BASELINE` 作为上次同步/发布的字段摘要，请勿手改。`update` 发布前比较基线、本地和远端：未在本地修改的字段自动采用远端值；不同字段的修改可以合并；同字段双方改成不同值则停止发布并提示先 sync，再编辑目标值。首次建立基线前，若本地与已有备份不同，也会停止而不猜测。已有恢复快照的部署使用条件更新获取远端锁，同时检查快照未被另一机器修改；正常结束释放锁，进程异常退出的锁最多保留 15 分钟。首次部署/首次建立备份请只用一台管理机执行。

首次部署只需填写：

```dotenv
CLOUDFLARE_ACCOUNT_ID=你的账号ID
CLOUDFLARE_API_TOKEN=你的API Token
```

Token 应针对目标账号具备 Workers Scripts 编辑、D1 编辑权限；脚本使用 Token，不需要 `wrangler login`。账号首次使用 Workers 时，需要先启用 workers.dev 子域名。CF Token 用于部署，与节点管理 Token 不同。

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
| `SSS_REALTIME_INTERVAL` | 有人查看时的上报间隔，默认 `2` 秒，支持 `1`–`60` 的整数秒 |

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

运行 `bash ./sss.sh`：菜单 **2** 添加、**3** 删除、**4** 修改、**5** 切换 Web 隐藏状态。启动时读取一次远端配置，之后查看、输入和校验均操作本地临时文件；所有修改在最后一步自动提交到远端，确认成功后才显示结果。查看、取消和无效输入不发起网络请求。其他管理机的修改由提交时的 revision 检查发现；需要查看最新远端配置时重新启动 CLI。提交使用 revision CAS，防止覆盖另一台管理机器的修改。提交失败会重新读取远端状态，不显示成功或未注册节点的安装命令。

添加成功后，复制脚本打印的完整命令到 VPS。普通用户直接执行，以该用户安装和运行；root 执行时会先询问确认，输入 `y` 后才以 root 安装和运行，回车、拒绝或无输入均取消。每次 root 安装或更新都需确认。命令包含节点凭据和相同 GitHub 源；Agent 以当前用户运行，不需要 Docker。安装器每次安装/更新都会确认当前用户 `Linger=yes`，保证注销后继续运行并随开机启动；即使 SSH 会话中的 manager 已正常运行，也不会跳过此检查。主机策略可能要求一次 sudo 授权以启用当前用户的 linger 或修复 manager。Agent 位于 `~/.local/share/sss/agent`，用户 service 位于 `~/.config/systemd/user/sss-agent.service`。

```bash
systemctl --user status sss-agent
journalctl --user -u sss-agent -n 50 --no-pager
```

若出现 `Failed to connect to bus`，安装器会按当前 UID 修正运行目录和 D-Bus 地址，再连接用户 manager。用户 manager 未启动时，会自动尝试启用当前用户的 linger；主机策略要求管理员权限时，自动调用 sudo 启用 linger 并启动对应的 `user@UID.service`，可能提示系统密码。Agent 本身仍以当前用户运行。若权限不足或系统服务损坏，安装器给出诊断，必要时检查 `libpam-systemd`、`dbus-user-session` 和服务日志。不要手动创建 `/run/user` 或放宽其权限。用户 manager 不可用时，安装器不会覆盖已有安装或删除无法停止的 Agent。

Agent 明确使用 `ServerStatus-Agent/1.0` 标识访问上报 API，避免 Python 默认 User-Agent 被边缘规则误拒。HTTP 错误会记录状态、Cloudflare 错误码和 CF-Ray，不打印节点凭据或响应正文；如果上报接口被 Access 或 Challenge 保护，需要允许机器客户端正常访问。

Agent 使用 WSS 长连接上报：有可见网页订阅时默认每 **2 秒**上报，无人查看时每 **60 秒**上报；网页收到推送即更新，切到后台会关闭订阅，切回自动恢复。Worker 的一个共享 Durable Object 保存最新状态，现有每分钟 Cron 将有变化的节点写入 D1，并进行离线通知检查。旧 Agent 的 HTTPS POST 接口继续可用，支持逐台升级，但旧 Agent 仍按原频率消耗 Worker 请求和 D1 写入。

统一 `.env` 中设置 `SSS_REALTIME_INTERVAL` 为 1–60 的整数秒（例如 `5`），运行 `bash ./sss.sh update` 后生效，新版 Agent 自动接收频率，无需再次安装。普通用户、root 确认安装和 linger 行为不变；Agent 使用 Python 标准库，不需要安装 pip 或额外运行依赖。Agent 原来的显式 `REPORT_INTERVAL` 参数作为最小间隔保留：若服务里手动指定了较大值，需要移除该覆盖才能达到 1 秒。

从最初的 WSS 版本升级时，请先保持 `SSS_REALTIME_INTERVAL=1`（或原有 `3`），部署 CF 并逐台更新 Agent，再设为 `5` 等新间隔。最初的 Agent 只接受 1、3、60 秒，直接向它下发 5 秒会触发重连。本次更新到支持 1–60 秒的 Agent 后，范围内的后续频率调整仅需更新 CF。无人查看时仍固定 60 秒，避免超过现有离线阈值。

按 11 节点全天每秒上报估算，DO 入站消息折算约 47,520 次请求/天；3 秒约 15,840 次，另需预留建立连接、重连、网页心跳、每分钟任务及同账号其他应用。每分钟保存 11 个节点约 15,840 次记录写入/天，索引增加的实际行写入应通过 D1 指标确认。使用单个 DO，仍需观察运行时长额度；不能把消息配额当作唯一限制。浏览器异常时退避重连，并最多每 60 秒 HTTP 回退查询，显示数据可能过期。

目标使用条件是 **11 个新版 WSS Agent，网页连续可见 24 小时，保持 1 秒更新**：不会按观看时长自动降频，也不依赖无人查看时的节省才能满足预算。单个 DO 即使全天持续计费，按 128 MB 计算约 11,059 GB-s/天，低于 13,000 GB-s/天免费额度；每分钟任务另外约 1,440 次 DO 请求/天。消息折算规则和额度见 [Cloudflare 官方计费说明](https://developers.cloudflare.com/durable-objects/platform/pricing/)。免费额度由账号共享；此预算不覆盖无限访客、异常重连、旧版 HTTP Agent 或其他应用的额外消耗。1 秒为目标采样/上报间隔，不是网络延迟保证。上线后需按完整 UTC 自然日核对 Worker、DO 请求及运行时长、D1 读写指标；本地模拟时钟测试不能替代线上额度验证。

迁移顺序：先发布 CF，再用原安装用户在每台 VPS 运行 Agent 安装器、选择 **1** 更新；只发布 CF 不会升级 VPS 上的程序。月流量沿用原统计方式，DO 休眠通过连接附件恢复状态；进程重启/发布断连后从 D1 最近的分钟快照恢复。最近一分钟尚未保存的瞬时指标可能丢失，若同时发生计数器重置，月流量也可能丢失该窗口的增量；该监控不作为精确计费账本。实际 Linux 采集、注销/重启后的服务持久运行仍需 VPS 验证。

旧安装若出现 SSH 退出后离线、重新登录后上线，请用安装 Agent 的同一用户执行 `sudo loginctl enable-linger "$(id -un)"`，并确认 `loginctl show-user "$(id -un)" -p Linger` 返回 `Linger=yes`。


删除节点成功后，其上报会被拒绝；在 VPS 运行安装器菜单 **2** 可卸载服务。隐藏只影响网页展示，不停止上报或通知。下载的 `sss-agent.sh` 执行结束后自动删除自身（含安装、更新、卸载、取消及失败退出），不会删除已安装 Agent。再次操作需重新下载。安装器菜单 **1** 更新现有 Agent，保留凭据；下载失败不会破坏旧安装。安装器会将 GitHub 源保存在 Agent 目录内私有的 `.env`，后续更新复用该来源；显式设置 `GITHUB_RAW_URL` 可覆盖。下载后校验 Cloudflare 协议标记，旧 TCP Agent 不会替换当前 Agent。

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

首次准备四个模拟节点：可见在线/离线、隐藏在线/离线。在线节点使用真实 WSS：打开网页时每 1 秒模拟上报，无人查看时每 60 秒。数据保存在 `.wrangler/manual-state`，重启保留修改。Ctrl+C 停止；停止后移除此目录可重置手动测试数据。可用 `SSS_SMOKE_PORT=8789 npm run smoke:local` 修改端口。

自动测试使用单独临时 D1/Worker，覆盖节点 CRUD、隐藏、并发版本冲突、Python 上报和资源加载；部署流程的 CF API/发布使用替身验证，生成的生产配置使用真实 Wrangler dry-run 编译。不会操作真实账号。Linux service 控制使用替身，不能代替实际 VPS 验证。

日常开发也可使用 `npm run db:migrate:local`、`npm run dev:local`（8787）。旧 `~/.config/sss/remote.env` 仅作为没有 `.env` 时的兼容读取来源。

[设计审计记录](cloudflare/DESIGN_AUDIT.md)包含月流量、通知交付和验证边界。

GitHub Actions 已配置 macOS、Ubuntu 22.04/24.04 的完整回归测试矩阵。本地 macOS 已验证 Bash 入口，其他系统以对应运行器结果为准；Debian 采用同一 Bash 实现，实际主机验收仍待完成。


## 合并与发布规则

合并到主分支时，必须同步将 `sss.sh` 默认下载源和 init 模板、Agent 安装器默认下载源、`.env.sample` 的 `GITHUB_RAW_URL` 调整到实际合并目标分支，并更新测试中的下载/归档地址与文档。先确认主分支名称，不假设为 main 或 master；当前开发分支的默认源在合并前保持不变。

已有管理机 `.env` 和 Agent 保存的下载源不会因合并自动改变。发布说明必须包含它们的来源切换与更新步骤；用户明确指定的分支/标签应保留，凭据及 D1 ID 不因来源切换而改动。合并前运行完整本地回归，合并后核对目标分支可下载 CLI、Agent 安装器、Python 程序和 service 模板。在已有安装仍依赖开发分支时，不能直接删除该分支而不提供迁移方式。
