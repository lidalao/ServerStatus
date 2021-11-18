#!/bin/bash

#========================================================
#   System Required: CentOS 7+ / Debian 8+ / Ubuntu 16+ /
#     Arch 未测试
#   Description: Server Status 监控安装脚本
#   Github: https://github.com/lidalao/ServerStatus
#========================================================

GITHUB_RAW_URL="https://raw.githubusercontent.com/lidalao/ServerStatus/master"

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[0;33m'
plain='\033[0m'
export PATH=$PATH:/usr/local/bin

pre_check() {
    command -v systemctl >/dev/null 2>&1
    if [[ $? != 0 ]]; then
        echo "不支持此系统：未找到 systemctl 命令"
        exit 1
    fi

    # check root
    [[ $EUID -ne 0 ]] && echo -e "${red}错误: ${plain} 必须使用root用户运行此脚本！\n" && exit 1
}

install_soft() {
    (command -v yum >/dev/null 2>&1 && yum install $* -y) ||
    (command -v apt >/dev/null 2>&1 && apt install $* -y) ||
    (command -v pacman >/dev/null 2>&1 && pacman -Syu $*) ||
    (command -v apt-get >/dev/null 2>&1 &&  apt-get install $* -y)

    if [[ $? != 0 ]]; then
        echo -e "${red}安装基础软件失败，稍等会${plain}"
        exit 1
    fi

    (command -v pip3 >/dev/null 2>&1 &&  pip3 install requests)
}

install_base() {
    (command -v curl >/dev/null 2>&1 && command -v wget >/dev/null 2>&1 && command -v pip3 >/dev/null 2>&1) || install_soft curl wget python3-pip python3
}

install_docker() {
    install_base
    command -v docker >/dev/null 2>&1
    if [[ $? != 0 ]]; then
        install_base
        echo -e "正在安装 Docker"
        bash <(curl -sL https://get.docker.com) >/dev/null 2>&1
        if [[ $? != 0 ]]; then
            echo -e "${red}下载Docker失败${plain}"
            exit 1
        fi
        systemctl enable docker.service
        systemctl start docker.service
        echo -e "${green}Docker${plain} 安装成功"
    fi

    command -v docker-compose >/dev/null 2>&1
    if [[ $? != 0 ]]; then
        echo -e "正在安装 Docker Compose"
        wget --no-check-certificate -O /usr/local/bin/docker-compose "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" >/dev/null 2>&1
        if [[ $? != 0 ]]; then
            echo -e "${red}下载Compose失败${plain}"
            return 0
        fi
        chmod +x /usr/local/bin/docker-compose
        echo -e "${green}Docker Compose${plain} 安装成功"
    fi
}


modify_bot_config(){
    if [[ $# < 2 ]]; then
        echo -e "${red}参数错误，未能正确提供tg bot信息，请手动修改docker-compse.yml中的bot信息 ${plain}"
        exit 1
    fi
    
    tg_chat_id=$1
    tg_bot_token=$2

    sed -i "s/tg_chat_id/${tg_chat_id}/" docker-compose.yml
    sed -i "s/tg_bot_token/${tg_bot_token}/" docker-compose.yml
}

install_dashboard(){ 
    
    install_docker

    if [  "$(docker ps -q -f name=bot4sss)" ]; then
        return 0
    fi

    echo -e "> 安装面板"
    
    wget --no-check-certificate ${GITHUB_RAW_URL}/docker-compose.yml >/dev/null 2>&1
    wget --no-check-certificate ${GITHUB_RAW_URL}/Dockerfile >/dev/null 2>&1
    wget --no-check-certificate ${GITHUB_RAW_URL}/bot.py >/dev/null 2>&1
    wget --no-check-certificate ${GITHUB_RAW_URL}/_sss.py >/dev/null 2>&1
    echo '{"servers":[]}' > config.json
    
    modify_bot_config "$@"

    echo -e "> 启动面板"
    (docker-compose up -d)  >/dev/null 2>&1
}

nodes_mgr(){
    python3 _sss.py
}


pre_check
install_dashboard "$@"
nodes_mgr
