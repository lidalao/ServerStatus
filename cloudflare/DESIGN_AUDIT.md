# 架构审计与验证记录（2026-09-30）

## 目标与边界

- Cloudflare 部署包含 Worker API、D1、Web 静态文件及通知 cron。
- Agent 在 Linux VPS 上运行，通过 HTTPS 上报；安装器和 sss.sh 从 GitHub 发布。
- 管理节点使用应用管理 Token，不要求管理机登录 Cloudflare；发布 Worker 时仍需要 Cloudflare 身份。
- CLI 在每次操作前读取最新配置，增删改和切换隐藏完成后自动通过 revision CAS 写入远端，确认成功后回显。
- 隐藏只影响网页展示；节点仍能上报、参与通知和 CLI 管理。隐藏不是数据访问权限：公共 stats 仍含隐藏节点。
- 本分支仅支持 CF 方案；Docker、自托管后端、Go 源码兼容路径、独立 bot 和旧 TCP 上报已移除。

## 本轮发现与修复

| 问题 | 修复 | 验证 |
| --- | --- | --- |
| REPORT_INTERVAL 被子串匹配成 PORT | 精确解析 KEY=VALUE，验证正整数和端口范围 | Python 参数回归 |
| IPv6 标志在采样间隔丢失、IPv4 被固定为 true | 缓存两个地址族的检测结果，每次采样带齐 | 模拟 IPv6-only 连续采样 |
| 安装器先卸载，下载失败破坏旧安装 | 先暂存下载并检查 Python 语法，再覆盖 | 首装、更新、失败后原文件不变 |
| 无参数更新不能保留配置 | 更新读取已有 service；首次安装要求带参数 | 菜单更新保留原凭据、调用 restart |
| 服务参数含特殊字符时被误解析 | 引号、转义和单次模板替换 | Bash 语法检查；普通配置集成测试 |
| null 配置导致 500、revision 类型被隐式转换 | 明确拒绝异常 JSON 和非整数 revision | 真实 Worker 请求 |
| metrics 可用数组或字符串布尔值污染显示 | 校验字段类型、有限数值和流量整数 | 异常上报请求 |
| VPS 重启丢失本月累计流量 | 按增量累计，计数器重置保留历史，短月重置日取月末 | 增量、重启、跨周期 |
| 通知失败先消费了状态变化 | 检查 Telegram 返回；成功后更新状态 | 失败重试、隐藏节点、上线/下线 |
| 删除后重复用户名继承旧指标 | 配置与孤立指标/通知状态清理在 D1 batch 中完成；上报写入时再次检查当前凭据 | 删除后重新添加，无旧指标 |
| 任意配置附加字段进入公共 stats | 仅公开已知节点元数据 | 密码与未知指标不公开 |
| GitHub master 与开发版不一致 | 下载源可指定分支/标签，补充发布一致性说明 | 本地 CLI、安装器流程 |

## 测试与发布

使用 `npm ci && npm run test:local`，不需要 CF 参数；测试使用单独临时 D1 和本地 Worker，结束清理。`bash ./sss.sh deploy --plan` 预览统一部署流程，不会部署远端；自动测试会执行真实 Wrangler dry-run 验证生成的部署包。正式部署使用 `bash ./sss.sh deploy`，自动应用迁移并发布。CLI/Agent 必须另行发布到 GitHub，CF 部署不会更新它们。

## 已知限制

- 实际 Linux systemd 用户服务、注销/重启后的存活未在此 macOS 环境验证；服务控制和下载使用替身测试。用户 manager 和 linger 取决于 VPS 主机策略，安装程序不要求 root。
- 未提供真实 CF 配置，因此未运行远端 D1、生产 cron、真实 Telegram 和域名部署。通知逻辑测试模拟 Telegram 请求。
- 地址族标志检测的是到指定外部目标的连通性，通知依据上报心跳；两者含义不同。
- 流量仅累计可观测增量，首报之前及最后一次上报到重启之间的流量无法恢复。每个 username 应只运行一个 Agent。
- 通知采用尽力交付；发送成功而状态保存失败时可能重复；同一 cron 周期内恢复的短暂离线可能不触发通知。
- 单次编辑使用临时文件；未完成输入不提交。并发冲突或提交失败会自动重读远端配置，不保留未提交节点或显示成功；无法重读时终止会话。

## cf CLI 的接入判断

2026-09-30 核对 Cloudflare [9 月 28 日开放测试版公告](https://blog.cloudflare.com/cloudflare-cf-cli-launch/)。cf 支持 API 命令发现、默认 JSON 输出及 `cf migrate`；对依赖 esbuild 的 Workers，迁移后仍可委托 Wrangler 构建。

建议在发布和资源管理层采用 cf：创建/查询 D1、查看 Worker 状态、配置域名及 Access 等；具体操作先通过当前版本的帮助与命令搜索确认。当前已经验证的 Wrangler 本地开发、D1 migration 和发布路径继续保留，后续在独立迁移步骤中固定 cf 版本并复跑本地集成与部署验证。

sss.sh 和 Agent 继续调用应用 API：节点属于应用业务数据，增加 cf 依赖会引入 Node.js 和 Cloudflare 账号凭据，偏离“任何 VPS 只配置应用 Token 就能管理节点”的目标。cf 使用 Cloudflare 账户身份；SSS_MANAGEMENT_TOKEN 仅用于我们的 Worker，两者不可混用。此轮没有安装 cf、执行迁移或操作远端资源。

## 分支范围收敛

移除了 docker-compose、Docker 环境样例、独立 bot、可选 Go 服务源码，CLI 不再回退本地服务管理，Agent/安装器不再支持 TCP 参数。缺失 Worker 参数时明确报错。macOS、Ubuntu/Debian CLI 使用 Bash + curl + jq。

## 统一配置与自动部署

`sss.sh init` 生成单一 `.env`，独立 `deploy` / `update` 命令负责完整部署/更新；默认菜单只管理节点。首次填写 CF Account ID、API Token；脚本自动创建或复用 D1、生成并保留管理 Token、迁移、发布和验证 API，再写回地址。管理机只需同文件中的 Worker URL 与管理 Token。文件按数据读取，不 source/eval，部署保存权限为 600。

发布前先进行真实 Wrangler dry-run；CF API 和远端发布的编排通过替身测试验证。失败不会清空节点或更换已保存凭据；临时 Secrets 文件清理。没有真实 CF 配置时仍可测试全套编排与本地 Worker。直接下载的 CLI 部署时获取 GitHub 完整源码，源码目录中部署使用当前 checkout。GitHub 发布仍需单独 commit/push。

## 入口与命令边界

默认 sss.sh 交互只有节点管理；init、deploy、update 是独立子命令，更新要求已有部署配置。只保留 Bash 管理实现，支持 macOS、Ubuntu/Debian。macOS 已实测，CI 配置 macOS 与 Ubuntu 的完整回归矩阵；未运行的 CI 不能视为其他 OS 已实测，Debian 实际主机验收仍待完成。

## Agent 遗留代码核对

Agent 的系统采集来自上游，当前传输和运行方式已移植为 Worker HTTPS 上报与用户 systemd 服务。目录名称保留不代表仍使用旧 TCP 上报。核对后修正安装器默认 master 下载源并持久保存安装来源；下载协议标记验证防止旧 TCP 版本覆盖。移除服务文件过时注释、不可达采集代码、旧线程 API；修复单向流量被过滤、速率初次采样和计数器重置问题。网络连通性/运营商探测仍使用 TCP socket，与已经移除的 TCP 上报协议不同。

## 分支其余模块审计（2026-09-30）

范围：Worker/API、D1 migration、通知任务、Web、节点管理 CLI、统一部署脚本、配置样例、手动冒烟脚本、CI 和部署文档。对照当前 CF-only 架构检查入口与数据契约。

| 发现 | 修复 |
| --- | --- |
| npm deploy 仍调用占位 ID 的生产模板，绕过统一配置 | 改为进入 sss.sh deploy，使用同一 .env、迁移和部署流程 |
| Worker 名称/账号变更后旧地址可能仍被当作部署成功地址 | 发布前检查 workers.dev 地址匹配；发布后分别验证实际 Worker 地址与配置域名 |
| CLI 输入 EOF 后可能循环或继续处理未完成操作 | 交互输入统一检查 EOF，退出且不提交未完成草稿 |
| CLI 可产生重名草稿，月流量起始日与 API 元数据校验不完整 | CLI 提前拒绝重名、无效日期；API 拒绝非法日期与元数据类型 |
| BOM 前缀 .env 键保存后可能残留旧值 | 保存前移除 BOM，并验证重新读取使用新值 |
| Web 使用普通对象保存节点名，特殊名称影响展开状态 | 使用无原型对象；离线详情关闭；HTTP 错误保留最后有效视图 |
| Web 详情展示未采集的 IO 为 0 | 移除无数据的 IO 项，只展示已有磁盘数据 |
| 手动冒烟启动验证失败，清理 Worker 后可能返回成功退出码 | 保留失败退出码，增加真实子进程失败与清理回归 |
| 菜单与审计文档仍指向旧部署教程/手动迁移步骤 | 改为当前 CLI 帮助和统一部署流程 |

验证：`npm run test:local` 共 43 个测试全部通过，无跳过；包括实际本地 Worker/D1、CLI 添加/修改/删除/隐藏、Python 上报、前端错误路径、部署 API/命令替身、真实 Wrangler dry-run、冒烟失败退出码。无需任何 CF 参数。`git diff --check` 通过。

边界：没有执行真实 CF 发布、真实 Telegram 投递或 Linux 用户 systemd 启停；CI 的 Ubuntu 环境也尚未实际运行。本地安装器测试用替身验证服务生成与更新，不能代替 VPS 实测。本地修改需单独提交并推送，GitHub 下载内容才会同步；CF 发布不会代替源码发布。

## 初始化依赖安装

`sss.sh init` 自动检查 curl、jq、Node.js 22+ 和 npm。缺少系统工具时，macOS 使用已有 Homebrew，Ubuntu/Debian 使用 apt-get（非 root 用户通过 sudo）。没有可用 Node/npm 时，从 nodejs.org 的 Node 22 发布目录下载匹配架构的 tar.gz，核对 SHA-256，验证可执行后安装到 `~/.local/share/sss/node`。后续脚本自动使用该运行时，不修改 shell 配置或替换系统 Node。

重复 init 会保留已有 .env 内容并设置权限 600；安装失败不覆盖配置或已安装运行时，暂存文件清理。help 不安装、不下载依赖。macOS 未安装 Homebrew 且缺少系统工具时，提示先安装 Homebrew再重试。

验证：完整本地回归 55 项全部通过，包括新增 12 项依赖引导场景。覆盖 macOS Intel/Apple Silicon、Linux x64/ARM64 的流程选择，缺少 npm、Homebrew/apt 工具安装、重复执行、下载/校验/包管理器失败与帮助命令。安装器、下载与架构使用替身测试，没有执行真实 Homebrew/apt 安装或官方二进制下载；对应系统的真实安装仍需实机验证。

## Agent 会话恢复与 HTTPS 上报修复（2026-09-30）

安装器按当前 UID 修正 XDG_RUNTIME_DIR 和 D-Bus 地址，拒绝连接其他用户的目录/socket。用户 manager 不可用时先尝试当前用户的 logind 授权，再按主机策略通过 sudo 启用该用户 linger 和启动 user@UID.service。恢复失败不替换安装文件；卸载无法停止服务时保留文件。Agent 仍运行在当前用户的 user service，不触碰旧版系统服务。

公开部署的接口验证发现：Python 默认 User-Agent 收到 Cloudflare 403 / error code 1010；明确的 ServerStatus-Agent/1.0 标识使健康接口返回 200，使用无效测试凭据的上报返回预期 401。Agent 增加该标识、JSON Accept 和明确成功响应校验；错误日志只保留状态码、CF 错误码及安全的 CF-Ray，不输出凭据或任意响应正文。无需部署 Worker 来更新此客户端行为。

本地 Wrangler 子进程显式禁止从生产 .env 和进程环境加载开发变量，避免本地冒烟测试意外读取生产管理 Token。完整本地回归 62 项通过，包含会话变量纠正、权限恢复成功/失败、重复安装、卸载保护、HTTPS 标识、错误脱敏及响应确认。systemd 恢复使用替身测试，真实 Linux 安装器恢复仍需 VPS 验收；公开 CF 请求未使用真实节点凭据。

## 节点操作即时提交（2026-09-30）

移除手动提交菜单。添加、删除、更新、隐藏切换在完整输入后自动提交；远端确认后才回显成功和 Agent 安装命令。查看只读取，操作前刷新配置，保留 CAS 并发保护。拒绝、网络失败和版本冲突后重读远端；服务端已提交但响应丢失时也重读确认当前配置，不重复写入或输出未经确认的安装命令。Worker 无需重新部署。

验证：63 项本地回归全部通过，无需 CF 配置。新增即时提交与回显顺序验证，并覆盖服务拒绝、网络失败、真实 CAS 冲突、提交成功后响应丢失；查看节点不改变远端 revision。

## root 安装确认（2026-09-30）

普通用户直接安装与更新，保持当前用户权限。root 执行时，每次安装或更新在下载、用户 manager 修复、写入及服务控制之前要求明确确认；仅 y/Y/yes/YES 放行，默认拒绝、EOF 和其他输入均取消。确认后使用 root 的用户目录与用户级服务，支持必要的 root linger/manager 恢复，不触碰旧系统 Agent。卸载仍只作用于当前用户已有安装。

验证：70 项本地回归全部通过，新增 7 项权限选择测试，覆盖普通用户免确认、root 同意、拒绝、默认回车、无输入、非法输入以及更新再次确认和配置保留。UID 与 systemd 使用替身，没有在本机以真实 root 安装或启动服务；VPS 生命周期仍需实机验证。

## 三秒刷新观察（2026-09-30）

按用户要求将 Agent 默认上报、网页轮询和本地模拟上报均改为 3 秒，保留 Agent 参数覆盖能力。两节点持续上报加一个全天打开的页面约 86,400 次动态请求/天；三节点约 115,200 次，超过 Workers 免费额度。实际观察需包含 D1 读写、失败重试、其他访客及同账号其他服务。生效需要发布 Web，并单独更新 VPS Agent；离线判断和通知调度不变。

验证：完整本地回归 70 项通过，Python 语法检查与 diff 检查通过。未执行真实 CF 发布或 VPS 更新。
