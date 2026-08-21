# 介绍
项目基于cppla版本ServerStatus， 增加如下功能：

- 更方便的节点管理, 支持增删改查
- 上下线通知（telegram）
- Agent机器安装脚本改为systemd， 支持开机自启

>由于未改动cppla版的任何代码，所以，我愿意把这个项目称为ServerStatus的小插件, 理论上它可以为任何版本的ServerStatus服务


# 新用户：全新部署

服务端需要 **docker**（没有就 `curl -sL https://get.docker.com | bash`）和 **jq**（`apt install -y jq`，只有节点管理脚本用得到）。

```bash
git clone https://github.com/lidalao/ServerStatus.git sss && cd sss

# 1. 填配置
cp .env.sample .env
vi .env          # TG_CHAT_ID / TG_BOT_TOKEN, 端口按需改
                 # Bot token 找 @BotFather, chat id 找 @getuserID

# 2. 建空节点表(必须, 否则 docker 会把 config.json 当目录创建, srv 起不来)
echo '{"servers":[]}' > config.json

# 3. 起栈
docker compose up -d --build
```

打开 `http://<你的IP>:8081`（端口即 `.env` 里的 `WEB_PORT`）就能看到面板了，此时还没有节点。

```bash
# 4. 加节点
sudo ./sss.sh
```

选 `2. 添加节点`，填名字/位置/类型，脚本会随机生成用户名密码、写进 `config.json`、重启 `srv`，然后打印出这台机器的 **agent 安装命令**——复制到被监控的机器上执行即可。命令忘了就用菜单 `1. 查看节点` 再翻出来。

# 老用户：升级

先看你的面板目录里有没有 `.git`：

```bash
cd /你的/面板目录 && ls -d .git
```

### 情况 A：有 `.git`（已经是仓库版）

```bash
git pull && docker compose up -d --build
```

完事。`.env`、`config.json`、`json/` 都已 gitignore，`git pull` 不会冲突。

### 情况 B：没有 `.git`（旧版 `wget sss.sh` 装的）

旧版是单文件下载安装的，没法 `git pull`，重新 clone 一次即可（只需这一次）。TG token 在旧目录自己的 `docker-compose.yml` 里，节点数据在 `config.json`。

```bash
# 在老目录(假设叫 sss)的上级执行
git clone https://github.com/lidalao/ServerStatus.git sss-new
cp sss/config.json sss-new/          # 节点数据: 每个节点的用户名密码都在里面, 丢了要挨台重装 agent

cd sss-new
cp .env.sample .env
grep TG_ ../sss/docker-compose.yml   # 打印出旧的 TG_CHAT_ID / TG_BOT_TOKEN
vi .env                              # 填进去; 端口保持默认

(cd ../sss && docker compose down)   # 停老栈, 释放端口
docker compose up -d --build
```

确认面板正常后老目录就能删了。**agent 端一台都不用动**——面板 IP、节点凭据、上报端口都没变。

> 升级后如果页面看着没变化，多半是 CDN（Cloudflare 之类）还攥着旧的 `js/app.js`。新版镜像已经让 nginx 下发 `Cache-Control: no-cache`，但**已经被缓存住的那份得手动 purge 一次**，之后就不用管了。

# 日常更新

```bash
git pull && docker compose up -d --build
```

前端是打进镜像的，所以必须带 `--build`。

# 节点管理

```bash
sudo ./sss.sh
```

`sss.sh` **只管节点**，不装 docker、不建镜像、不起栈——那些都是 `docker compose` 的事。它做的是：增删改查 `config.json`、`docker compose restart srv` 让配置生效、打印 agent 安装命令。

```
1. 查看节点   看某个节点的位置/类型/用户名/密码, 并重新打印 agent 安装命令(回车看全部)
2. 添加节点   随机生成凭据, 加完直接给出 agent 安装命令
3. 删除节点
4. 更新节点   改名字/位置/类型/月流量起始日
0. 退出
```

更多信息请移步 https://lidalao.com/archives/87  +1ip

挺好用的？送作者一杯可乐？->
 [<img src="https://user-images.githubusercontent.com/52455330/139071980-91302a8a-37b1-4196-803e-f91b1de2ee5b.gif" width="60" height="40" />](https://shop.lidalao.com/buy/4)

# 参考
- https://github.com/cppla/ServerStatus
- https://github.com/naiba/nezha
