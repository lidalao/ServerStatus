# 介绍
项目基于cppla版本ServerStatus， 增加如下功能：

- 更方便的节点管理, 支持增删改查
- 上下线通知（telegram）
- Agent机器安装脚本改为systemd， 支持开机自启

>由于未改动cppla版的任何代码，所以，我愿意把这个项目称为ServerStatus的小插件, 理论上它可以为任何版本的ServerStatus服务


# 安装
在**服务端**复制以下命令，一键到底。请记得替换成你自己的YOUR_TG_CHAT_ID和YOUR_TG_BOT_TOKEN。

其中，Bot token可以通过@BotFather创建机器人获取， Chat id可以通过@getuserID获取。

```
mkdir sss && cd sss && wget --no-check-certificate https://raw.githubusercontent.com/lidalao/ServerStatus/master/sss.sh && chmod +x ./sss.sh && sudo ./sss.sh YOUR_TG_CHAT_ID YOUR_TG_BOT_TOKEN

```

更多信息请移步 https://lidalao.com/archives/87  +1ip

# 参考
- https://github.com/cppla/ServerStatus
- https://github.com/naiba/nezha
