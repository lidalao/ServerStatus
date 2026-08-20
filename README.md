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

TG 配置会写进仓库下的 `.env`（已 gitignore），节点数据在 `config.json`（同样 gitignore），所以更新代码不会有冲突。

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
