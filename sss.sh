#!/bin/bash

#========================================================
#   System Required: CentOS 7+ / Debian 8+ / Ubuntu 16+ /
#     Arch 未测试
#   Description: Server Status 监控安装 + 节点管理脚本
#   Github: https://github.com/lidalao/ServerStatus
#========================================================

GITHUB_RAW_URL="https://raw.githubusercontent.com/lidalao/ServerStatus/master"
CONFIG_FILE="config.json"

# ---- 颜色(真实 ESC 字符, printf/echo 通用) ----
red=$'\e[0;31m'
green=$'\e[0;32m'
yellow=$'\e[0;33m'
blue=$'\e[0;34m'
cyan=$'\e[0;36m'
bold=$'\e[1m'
dim=$'\e[2m'
plain=$'\e[0m'
export PATH=$PATH:/usr/local/bin

# ---- UI 助手 ----
banner() {
    printf '%s\n' "${cyan}${bold}"
    cat <<'EOF'
   ____                          ____  _        _
  / ___|  ___ _ ____   _____ _ _/ ___|| |_ __ _| |_ _   _ ___
  \___ \ / _ \ '__\ \ / / _ \ '__\___ \| __/ _` | __| | | / __|
   ___) |  __/ |   \ V /  __/ |   ___) | || (_| | |_| |_| \__ \
  |____/ \___|_|    \_/ \___|_|  |____/ \__\__,_|\__|\__,_|___/
EOF
    printf '%s\n' "${plain}${dim}  最简洁的探针 · ServerStatus 面板管理${plain}"
}
line() { printf '%s\n' "${dim}  ────────────────────────────────────────────${plain}"; }
info() { printf '%s\n' "${cyan}[*]${plain} $*"; }
ok()   { printf '%s\n' "${green}[✓]${plain} $*"; }
warn() { printf '%s\n' "${yellow}[!]${plain} $*"; }
err()  { printf '%s\n' "${red}[✗]${plain} $*"; }
step() { printf '\n%s\n' "${blue}${bold}»${plain} ${bold}$*${plain}"; }
ask()  { printf '%s' "${cyan}»${plain} $* "; }
pause(){ printf '\n%s' "${dim}按回车继续…${plain}"; read -r _; }

pre_check() {
    command -v systemctl >/dev/null 2>&1
    if [[ $? != 0 ]]; then
        err "不支持此系统：未找到 systemctl 命令"
        exit 1
    fi

    # check root
    [[ $EUID -ne 0 ]] && err "必须使用 root 用户运行此脚本！" && exit 1
}

install_soft() {
    (command -v yum >/dev/null 2>&1 && yum install $* -y) ||
    (command -v apt >/dev/null 2>&1 && apt install $* -y) ||
    (command -v pacman >/dev/null 2>&1 && pacman -Syu $*) ||
    (command -v apt-get >/dev/null 2>&1 &&  apt-get install $* -y)

    if [[ $? != 0 ]]; then
        err "安装基础软件失败，稍等会重试"
        exit 1
    fi
}

install_base() {
    (command -v curl >/dev/null 2>&1 && command -v wget >/dev/null 2>&1 && command -v jq >/dev/null 2>&1) ||
        install_soft curl wget jq
}

install_docker() {
    install_base
    command -v docker >/dev/null 2>&1
    if [[ $? != 0 ]]; then
        install_base
        info "正在安装 Docker"
        bash <(curl -sL https://get.docker.com) >/dev/null 2>&1
        if [[ $? != 0 ]]; then
            err "下载 Docker 失败"
            exit 1
        fi
        systemctl enable docker.service
        systemctl start docker.service
        ok "Docker 安装成功"
    fi

    command -v docker-compose >/dev/null 2>&1
    if [[ $? != 0 ]]; then
        info "正在安装 Docker Compose"
        wget --no-check-certificate -O /usr/local/bin/docker-compose "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" >/dev/null 2>&1
        if [[ $? != 0 ]]; then
            err "下载 Compose 失败"
            return 0
        fi
        chmod +x /usr/local/bin/docker-compose
        ok "Docker Compose 安装成功"
    fi
}

modify_bot_config() {
    if [[ $# -lt 2 ]]; then
        err "参数错误，未能正确提供 tg bot 信息，请手动修改 docker-compose.yml 中的 bot 信息"
        exit 1
    fi

    local tg_chat_id=$1
    local tg_bot_token=$2

    sed -i "s/tg_chat_id/${tg_chat_id}/" docker-compose.yml
    sed -i "s/tg_bot_token/${tg_bot_token}/" docker-compose.yml
}

install_dashboard() {
    install_docker

    if [ "$(docker ps -q -f name=sss-web)" ]; then
        return 0
    fi

    step "安装面板"

    wget --no-check-certificate ${GITHUB_RAW_URL}/docker-compose.yml >/dev/null 2>&1

    mkdir -p service/bot service/web/css service/web/js service/web/fonts
    wget --no-check-certificate -qO service/bot/Dockerfile   ${GITHUB_RAW_URL}/service/bot/Dockerfile
    wget --no-check-certificate -qO service/bot/bot.py        ${GITHUB_RAW_URL}/service/bot/bot.py
    wget --no-check-certificate -qO service/web/Dockerfile    ${GITHUB_RAW_URL}/service/web/Dockerfile
    wget --no-check-certificate -qO service/web/index.html    ${GITHUB_RAW_URL}/service/web/index.html
    wget --no-check-certificate -qO service/web/favicon.svg   ${GITHUB_RAW_URL}/service/web/favicon.svg
    wget --no-check-certificate -qO service/web/css/app.css   ${GITHUB_RAW_URL}/service/web/css/app.css
    wget --no-check-certificate -qO service/web/js/app.js     ${GITHUB_RAW_URL}/service/web/js/app.js
    for w in 400 600 700; do
        wget --no-check-certificate -qO service/web/fonts/cascadia-code-$w.woff2 ${GITHUB_RAW_URL}/service/web/fonts/cascadia-code-$w.woff2
    done

    [ -f "$CONFIG_FILE" ] || echo '{"servers":[]}' > "$CONFIG_FILE"

    modify_bot_config "$@"

    step "构建并启动面板"
    (docker-compose up -d --build) >/dev/null 2>&1
    ok "面板已启动，web 地址：http://<本机IP>:8081"
}

# ================= 节点管理(纯 shell + jq) =================

ensure_config() { [ -f "$CONFIG_FILE" ] || echo '{"servers":[]}' > "$CONFIG_FILE"; }

get_ip() { curl -s --max-time 10 https://api.ipify.org 2>/dev/null || printf '%s' "<本机IP>"; }

gen_user() {
    if [ -r /proc/sys/kernel/random/uuid ]; then
        tr -d '-' < /proc/sys/kernel/random/uuid
    elif command -v uuidgen >/dev/null 2>&1; then
        uuidgen | tr -d '-' | tr 'A-Z' 'a-z'
    else
        head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n'
    fi
}

gen_pass() {
    local nums='23456789' low='abcdefghijkmnpqrstuvwxyz' up='ABCDEFGHJKLMNPQRSTUVWXYZ' all p='' i out
    all="${nums}${low}${up}"
    p+="${nums:RANDOM%${#nums}:1}"
    p+="${low:RANDOM%${#low}:1}"
    p+="${up:RANDOM%${#up}:1}"
    for i in 1 2 3 4 5 6 7 8 9; do p+="${all:RANDOM%${#all}:1}"; done
    out=$(printf '%s' "$p" | fold -w1 | shuf 2>/dev/null | tr -d '\n')
    [ -z "$out" ] && out="$p"
    printf '%s' "$out"
}

restart_stack() {
    info "操作完成，等待服务重启…"
    (docker-compose restart) >/dev/null 2>&1
    ok "完成"
}

print_agent_cmd() {
    local user="$1" pass="$2" ip
    ip=$(get_ip)
    echo
    line
    printf '%s\n' "${green}curl -L ${GITHUB_RAW_URL}/agent/sss-agent.sh -o sss-agent.sh && chmod +x sss-agent.sh && sudo ./sss-agent.sh ${ip} ${user} ${pass}${plain}"
    line
}

list_nodes() {
    ensure_config
    local count
    count=$(jq '.servers | length' "$CONFIG_FILE")
    echo
    if [ "$count" -eq 0 ]; then
        warn "暂时没有任何节点，使用「添加节点」开始吧"
        return
    fi
    printf "  ${bold}%-5s %-18s %-10s %-8s${plain}\n" "ID" "NAME" "LOCATION" "TYPE"
    line
    jq -r '.servers | to_entries[] | "\(.key)|\(.value.name)|\(.value.location)|\(.value.type)"' "$CONFIG_FILE" |
    while IFS='|' read -r id name loc type; do
        printf "  %-5s %-18s %-10s %-8s\n" "$id" "$name" "$loc" "$type"
    done
}

add_node() {
    ensure_config
    local name loc type user pass tmp
    echo
    ask "请输入节点名字:"; read -r name
    [ -z "$name" ] && { err "名字不能为空"; return; }
    ask "请输入位置 [us]:"; read -r loc;  loc=${loc:-us}
    ask "请输入类型 [kvm]:"; read -r type; type=${type:-kvm}

    user=$(gen_user)
    pass=$(gen_pass)

    tmp=$(mktemp)
    jq --arg name "$name" --arg loc "$loc" --arg type "$type" --arg user "$user" --arg pass "$pass" \
       '.servers += [{monthstart:"1",location:$loc,type:$type,name:$name,username:$user,host:$name,password:$pass}] | .servers |= sort_by(.name)' \
       "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE" || { err "写入 config.json 失败"; rm -f "$tmp"; return; }

    ok "添加成功: ${bold}${name}${plain}"
    restart_stack
    list_nodes
    echo
    info "请复制以下命令在机器 ${bold}${name}${plain} 安装 agent 服务:"
    print_agent_cmd "$user" "$pass"
}

remove_node() {
    ensure_config
    list_nodes
    local count idx name yn tmp
    count=$(jq '.servers | length' "$CONFIG_FILE")
    [ "$count" -eq 0 ] && return
    echo
    ask "请输入要删除的节点编号:"; read -r idx
    [[ "$idx" =~ ^[0-9]+$ ]] || { err "无效输入"; return; }
    [ "$idx" -ge "$count" ] && { err "编号超出范围"; return; }
    name=$(jq -r ".servers[$idx].name" "$CONFIG_FILE")
    ask "确认删除节点 ${bold}${name}${plain}? [y/N]"; read -r yn
    case "$yn" in
        y|Y) ;;
        *) info "已取消删除"; return ;;
    esac
    tmp=$(mktemp)
    jq "del(.servers[$idx])" "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE" || { err "写入失败"; rm -f "$tmp"; return; }
    ok "删除成功: ${bold}${name}${plain}"
    restart_stack
    list_nodes
}

update_node() {
    ensure_config
    list_nodes
    local count idx oname oloc otype omonth name loc type month tmp
    count=$(jq '.servers | length' "$CONFIG_FILE")
    [ "$count" -eq 0 ] && return
    echo
    ask "请输入要更新的节点编号:"; read -r idx
    [[ "$idx" =~ ^[0-9]+$ ]] || { err "无效输入"; return; }
    [ "$idx" -ge "$count" ] && { err "编号超出范围"; return; }

    oname=$(jq -r ".servers[$idx].name" "$CONFIG_FILE")
    oloc=$(jq -r ".servers[$idx].location" "$CONFIG_FILE")
    otype=$(jq -r ".servers[$idx].type" "$CONFIG_FILE")
    omonth=$(jq -r ".servers[$idx].monthstart" "$CONFIG_FILE")

    printf '%s\n' "${dim}回车保留原值(中括号内为原值)${plain}"
    ask "新名字 [${oname}]:";        read -r name;  name=${name:-$oname}
    ask "新位置 [${oloc}]:";         read -r loc;   loc=${loc:-$oloc}
    ask "新类型 [${otype}]:";        read -r type;  type=${type:-$otype}
    ask "月流量起始日 [${omonth}]:"; read -r month; month=${month:-$omonth}

    if [ "$name" = "$oname" ] && [ "$loc" = "$oloc" ] && [ "$type" = "$otype" ] && [ "$month" = "$omonth" ]; then
        info "未做任何更新，直接返回"
        return
    fi

    tmp=$(mktemp)
    jq --arg n "$name" --arg l "$loc" --arg t "$type" --arg m "$month" \
       ".servers[$idx].name=\$n | .servers[$idx].location=\$l | .servers[$idx].type=\$t | .servers[$idx].monthstart=\$m | .servers |= sort_by(.name)" \
       "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE" || { err "写入失败"; rm -f "$tmp"; return; }

    ok "更新成功"
    restart_stack
    list_nodes
}

menu_loop() {
    ensure_config
    while true; do
        clear 2>/dev/null
        banner
        printf '%s\n' "${dim}  详细教程: https://lidalao.com/archives/87${plain}"
        list_nodes
        echo
        printf '%s\n' "  ${bold}操作菜单${plain}"
        printf '%s\n' "    ${green}1${plain}. 查看节点      ${green}2${plain}. 添加节点"
        printf '%s\n' "    ${green}3${plain}. 删除节点      ${green}4${plain}. 更新节点"
        printf '%s\n' "    ${green}0${plain}. 退出"
        echo
        ask "请输入操作编号:"; read -r op
        case "$op" in
            1) list_nodes; pause ;;
            2) add_node;    pause ;;
            3) remove_node; pause ;;
            4) update_node; pause ;;
            0) echo; ok "再见 👋"; exit 0 ;;
            *) err "无效输入"; pause ;;
        esac
    done
}

# ================= 入口 =================
clear 2>/dev/null
banner
pre_check
install_dashboard "$@"
menu_loop
