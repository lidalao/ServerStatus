# 介绍
项目基于cppla版本ServerStatus， 增加如下功能：

- 更方便的节点管理, 支持增删改查
- 上下线通知（telegram）
- Agent机器安装脚本改为systemd， 支持开机自启

>由于未改动cppla版的任何代码，所以，我愿意把这个项目称为ServerStatus的小插件, 理论上它可以为任何版本的ServerStatus服务


# 安装
在**服务端**克隆本仓库后一键安装。请记得替换成你自己的YOUR_TG_CHAT_ID和YOUR_TG_BOT_TOKEN。

其中，Bot token可以通过@BotFather创建机器人获取， Chat id可以通过@getuserID获取。

```
git clone https://github.com/lidalao/ServerStatus.git sss && cd sss && sudo ./sss.sh YOUR_TG_CHAT_ID YOUR_TG_BOT_TOKEN
```

安装成功后，web服务地址：http://ip:8081

TG 配置会写进仓库下的 `.env`（已 gitignore，格式见 `.env.sample`），节点数据在 `config.json`（同样 gitignore），所以更新代码不会有冲突。

不想用安装脚本、只想手动起栈的话：`cp .env.sample .env` 填好值，然后 `docker compose up -d --build`。

端口也在 `.env` 里：`WEB_PORT`（面板 web，默认 8081）和 `REPORT_PORT`（agent 上报，默认 35601），改完 `docker compose up -d` 生效。**`REPORT_PORT` 只在面板还没接入任何 agent 时改**——已经在跑的 agent 连的是老端口，改了会全部离线；而且新端口不会自动写进 agent 安装命令，得手动在 `/etc/systemd/system/sss-agent.service` 的 `ExecStart` 末尾补 `PORT=<端口>`。

# 从旧版迁移
旧版是 `wget sss.sh` 单文件安装的，目录里没有 `.git`，没法直接 `git pull`，重新 clone 一次即可（只需一次）。老目录里的 TG token 在它自己的 `docker-compose.yml` 里，节点数据在 `config.json`。

```
# 在老目录 sss 的上级执行
git clone https://github.com/lidalao/ServerStatus.git sss-new
cp sss/config.json sss-new/                 # 节点数据(用户名/密码都在里面, 别丢)

cd sss-new
cp .env.sample .env
grep TG_ ../sss/docker-compose.yml          # 看到旧的 TG_CHAT_ID / TG_BOT_TOKEN
vi .env                                     # 把这两个值填进去

(cd ../sss && docker compose down)           # 停掉老栈, 释放 35601/8081 端口
sudo ./sss.sh                               # 不带参数, 直接读 .env
```

确认面板正常后老目录就可以删了。之后更新见上面的「更新」一节。

# 更新
在服务端的仓库目录下：

```
git pull && sudo ./sss.sh
```

或者在节点管理菜单里选 `5. 更新面板`（等价于 `git pull` + 重建镜像）。

只想手动重建也可以：

```
git pull && docker compose up -d --build
```

更多信息请移步 https://lidalao.com/archives/87  +1ip

挺好用的？送作者一杯可乐？->
 [<img src="https://user-images.githubusercontent.com/52455330/139071980-91302a8a-37b1-4196-803e-f91b1de2ee5b.gif" width="60" height="40" />](https://shop.lidalao.com/buy/4)



# 参考
- https://github.com/cppla/ServerStatus
- https://github.com/naiba/nezha
