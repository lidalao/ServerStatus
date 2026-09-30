#!/bin/bash

#========================================================
#   Supported: macOS / Ubuntu / Debian (Bash, curl, jq)
#   Description: Cloudflare Server Status 远程节点管理
#   Github: https://github.com/lidalao/ServerStatus
#========================================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SSS_ENV_FILE="${SSS_ENV_FILE:-$SCRIPT_DIR/.env}"
LEGACY_ENV_FILE="${XDG_CONFIG_HOME:-$HOME/.config}/sss/remote.env"
DIRTY=0
REVISION=0
CONFIG_FILE=""
SSS_NODE_PATH="$HOME/.local/share/sss/node"
[ ! -d "$SSS_NODE_PATH/bin" ] || export PATH="$SSS_NODE_PATH/bin:$PATH"

# .env 是数据文件，绝不 source 或 eval；环境变量优先。
read_settings() {
    local settings="$1" key value
    [ -f "$settings" ] || return 0
    while IFS='=' read -r key value || [ -n "$key$value" ]; do
        key=${key#$'\xef\xbb\xbf'}; key=${key%$'\r'}; value=${value%$'\r'}
        key="${key#"${key%%[![:space:]]*}"}"; key="${key%"${key##*[![:space:]]}"}"
        value="${value#"${value%%[![:space:]]*}"}"; value="${value%"${value##*[![:space:]]}"}"
        case "$value" in
            \"*\") value=${value#\"}; value=${value%\"} ;;
            \'*\') value=${value#\'}; value=${value%\'} ;;
        esac
        case "$key" in
            CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID|SSS_WORKER_NAME|SSS_D1_NAME|SSS_D1_ID|SSS_WORKER_URL|SSS_MANAGEMENT_TOKEN|TG_BOT_TOKEN|TG_CHAT_ID|GITHUB_RAW_URL)
                [ -n "${!key}" ] || printf -v "$key" '%s' "$value"
                export "$key"
                ;;
        esac
    done < "$settings"
}
if [ -f "$SSS_ENV_FILE" ]; then
    read_settings "$SSS_ENV_FILE"
else
    read_settings "$LEGACY_ENV_FILE"
fi
GITHUB_RAW_URL="${GITHUB_RAW_URL:-https://raw.githubusercontent.com/lidalao/ServerStatus/feature/cloudflare-monitor}"
SSS_WORKER_URL="${SSS_WORKER_URL:-}"
SSS_MANAGEMENT_TOKEN="${SSS_MANAGEMENT_TOKEN:-}"
export GITHUB_RAW_URL SSS_WORKER_URL SSS_MANAGEMENT_TOKEN

# 临时配置用于单次编辑；每次完整操作自动提交到 Worker。
CONFIG_FILE=$(mktemp) || exit 1
trap 'rm -f "$CONFIG_FILE"' EXIT

# ---- 颜色(真实 ESC 字符, printf/echo 通用) ----
red=$'\e[0;31m'
green=$'\e[0;32m'
yellow=$'\e[0;33m'
cyan=$'\e[0;36m'
bold=$'\e[1m'
dim=$'\e[2m'
plain=$'\e[0m'

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
ask()  { printf '%s' "${cyan}»${plain} $* "; }
read_input() {
    if ! read -r "$1"; then
        warn "输入已结束，退出管理会话；未完成的操作不会写入远程。"
        exit 0
    fi
}
pause(){ printf '\n%s' "${dim}按回车继续…${plain}"; read_input _; }

pre_check() {
    local miss=0
    command -v jq >/dev/null 2>&1 || {
        case "$(uname -s)" in
            Darwin) err "缺少 jq，请先执行 brew install jq" ;;
            *) err "缺少 jq，Ubuntu/Debian 请先安装 jq" ;;
        esac
        miss=1
    }
    command -v curl   >/dev/null 2>&1 || { err "缺少 curl"; miss=1; }
    [ "$miss" = 1 ] && exit 1
    if [[ -z "$SSS_WORKER_URL" && -z "$SSS_MANAGEMENT_TOKEN" ]]; then
        err "尚未配置 Cloudflare Worker 管理参数。"
        err "请在 ${SSS_ENV_FILE} 配置参数；首次部署可执行: bash $0 --deploy"
        exit 1
    fi
    [[ -z "$SSS_WORKER_URL" || -z "$SSS_MANAGEMENT_TOKEN" ]] && { err "请同时配置 SSS_WORKER_URL 与 SSS_MANAGEMENT_TOKEN"; exit 1; }
    SSS_WORKER_URL=${SSS_WORKER_URL%/}
    load_remote_config || exit 1
}

load_remote_config() {
    local response
    response=$(curl -fsS --max-time 20 -H "Authorization: Bearer ${SSS_MANAGEMENT_TOKEN}" \
        "${SSS_WORKER_URL}/api/admin/config") || { err "无法读取 Worker 配置，请检查地址、Token 与网络"; return 1; }
    if ! printf '%s' "$response" | jq -e '(.config.servers | type == "array") and (.revision | type == "number" and . >= 0 and . <= 9007199254740991 and . == floor)' >/dev/null 2>&1; then
        err "Worker 返回的配置格式无效: $(printf '%s' "$response" | jq -r '.error // "invalid response"' 2>/dev/null)"
        return 1
    fi
    REVISION=$(printf '%s' "$response" | jq -r '.revision')
    printf '%s' "$response" | jq '.config' > "$CONFIG_FILE" || return 1
    DIRTY=0
}

submit_remote_config() {
    [[ "$DIRTY" -eq 1 ]] || { info "没有待提交的修改"; return 0; }
    local payload response
    payload=$(jq -cn --argjson revision "$REVISION" --slurpfile config "$CONFIG_FILE" \
        '{revision:$revision,config:$config[0]}') || { err "无法生成提交数据"; return 1; }
    response=$(curl -sS --max-time 30 -H "Authorization: Bearer ${SSS_MANAGEMENT_TOKEN}" \
        -H 'Content-Type: application/json' -X PUT --data-binary "$payload" \
        "${SSS_WORKER_URL}/api/admin/config") || { err "提交失败，请检查网络后重试"; return 1; }
    if printf '%s' "$response" | jq -e '.ok == true and (.revision | type == "number" and . >= 0 and . <= 9007199254740991 and . == floor)' >/dev/null 2>&1; then
        REVISION=$(printf '%s' "$response" | jq -r '.revision')
        DIRTY=0
        ok "已提交到 Cloudflare (revision ${REVISION})"
        return 0
    fi
    err "远程拒绝提交: $(printf '%s' "$response" | jq -r '.error // "unknown error"' 2>/dev/null)"
    warn "本次操作未确认成功，正在重新读取远端配置；不会覆盖其他机器的修改。"
    return 1
}

# ================= 节点管理(自动远程提交) =================
ensure_config() {
    [ -s "$CONFIG_FILE" ] || { err "本地会话配置不可用，请重新启动管理 CLI"; exit 1; }
}

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

save_node_change() {
    DIRTY=1
    if submit_remote_config; then
        return 0
    fi
    # A timeout may happen after the server committed. Always reconcile with
    # the remote state, never show success or retain an uncommitted local node.
    load_remote_config || { err "无法确认远端状态，已停止会话；请恢复网络后重新查看节点"; exit 1; }
    err "操作未确认成功，已恢复远端配置；请查看节点后重试"
    return 1
}

print_agent_cmd() {
    local user="$1" pass="$2"
    echo
    line
    info "节点已保存到远端，可在目标 VPS 执行安装命令。"
    printf '%s' "$green"
    printf 'curl -fsSL %q -o sss-agent.sh && GITHUB_RAW_URL=%q bash ./sss-agent.sh --worker %q %q %q\n' \
        "${GITHUB_RAW_URL}/agent/sss-agent.sh" "$GITHUB_RAW_URL" "$SSS_WORKER_URL" "$user" "$pass"
    printf '%s' "$plain"
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
    printf "  ${bold}%-5s %-18s %-10s %-8s %-7s${plain}\n" "ID" "NAME" "LOCATION" "TYPE" "WEB"
    line
    jq -r '.servers | to_entries[] | "\(.key)|\(.value.name)|\(.value.location)|\(.value.type)|\(if .value.hidden then "hidden" else "shown" end)"' "$CONFIG_FILE" |
    while IFS='|' read -r id name loc type web; do
        printf "  %-5s %-18s %-10s %-8s %-7s\n" "$id" "$name" "$loc" "$type" "$web"
    done
}

show_node_detail() {
    local idx="$1" name loc type month user pass hidden
    name=$(jq -r ".servers[$idx].name" "$CONFIG_FILE")
    loc=$(jq -r ".servers[$idx].location" "$CONFIG_FILE")
    type=$(jq -r ".servers[$idx].type" "$CONFIG_FILE")
    month=$(jq -r ".servers[$idx].monthstart" "$CONFIG_FILE")
    hidden=$(jq -r ".servers[$idx].hidden // false" "$CONFIG_FILE")
    user=$(jq -r ".servers[$idx].username" "$CONFIG_FILE")
    pass=$(jq -r ".servers[$idx].password" "$CONFIG_FILE")
    echo
    line
    printf "  ${bold}[%s] %s${plain}\n" "$idx" "$name"
    printf "  位置 LOCATION   : %s\n" "$loc"
    printf "  类型 TYPE       : %s\n" "$type"
    printf "  月流量起始日    : %s\n" "$month"
    printf "  Web 显示        : %s\n" "$([[ "$hidden" == true ]] && printf '隐藏' || printf '显示')"
    printf "  用户名 USER     : %s\n" "$user"
    printf "  密码 PASSWORD   : %s\n" "$pass"
    info "在机器 ${bold}${name}${plain} 上执行以下命令安装 agent 服务:"
    print_agent_cmd "$user" "$pass"
}

view_node() {
    ensure_config
    list_nodes
    local count idx i
    count=$(jq '.servers | length' "$CONFIG_FILE")
    [ "$count" -eq 0 ] && return
    echo
    ask "请输入要查看的节点编号(回车查看全部):"; read_input idx
    if [ -z "$idx" ]; then
        i=0
        while [ "$i" -lt "$count" ]; do
            show_node_detail "$i"
            i=$((i + 1))
        done
        return
    fi
    [[ "$idx" =~ ^[0-9]+$ ]] || { err "无效输入"; return; }
    [ "$idx" -ge "$count" ] && { err "编号超出范围"; return; }
    show_node_detail "$idx"
}

add_node() {
    ensure_config
    local name loc type user pass tmp
    echo
    ask "请输入节点名字:"; read_input name
    [[ "$name" =~ [^[:space:]] ]] || { err "名字不能为空"; return; }
    jq -e --arg n "$name" '.servers | any(.name == $n)' "$CONFIG_FILE" >/dev/null && { err "节点名字已存在"; return; }
    ask "请输入位置 [us]:"; read_input loc;  loc=${loc:-us}
    ask "请输入类型 [kvm]:"; read_input type; type=${type:-kvm}

    user=$(gen_user)
    pass=$(gen_pass)

    tmp=$(mktemp)
    jq --arg name "$name" --arg loc "$loc" --arg type "$type" --arg user "$user" --arg pass "$pass" \
       '.servers += [{monthstart:"1",location:$loc,type:$type,name:$name,username:$user,host:$name,password:$pass}] | .servers |= sort_by(.name)' \
       "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE" || { err "写入 config.json 失败"; rm -f "$tmp"; return; }

    save_node_change || return 1
    ok "添加成功: ${bold}${name}${plain}"
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
    ask "请输入要删除的节点编号:"; read_input idx
    [[ "$idx" =~ ^[0-9]+$ ]] || { err "无效输入"; return; }
    [ "$idx" -ge "$count" ] && { err "编号超出范围"; return; }
    name=$(jq -r ".servers[$idx].name" "$CONFIG_FILE")
    ask "确认删除节点 ${bold}${name}${plain}? [y/N]"; read_input yn
    case "$yn" in
        y|Y) ;;
        *) info "已取消删除"; return ;;
    esac
    tmp=$(mktemp)
    jq "del(.servers[$idx])" "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE" || { err "写入失败"; rm -f "$tmp"; return; }
    save_node_change || return 1
    ok "删除成功: ${bold}${name}${plain}"
    list_nodes
}

update_node() {
    ensure_config
    list_nodes
    local count idx oname oloc otype omonth name loc type month tmp
    count=$(jq '.servers | length' "$CONFIG_FILE")
    [ "$count" -eq 0 ] && return
    echo
    ask "请输入要更新的节点编号:"; read_input idx
    [[ "$idx" =~ ^[0-9]+$ ]] || { err "无效输入"; return; }
    [ "$idx" -ge "$count" ] && { err "编号超出范围"; return; }

    oname=$(jq -r ".servers[$idx].name" "$CONFIG_FILE")
    oloc=$(jq -r ".servers[$idx].location" "$CONFIG_FILE")
    otype=$(jq -r ".servers[$idx].type" "$CONFIG_FILE")
    omonth=$(jq -r ".servers[$idx].monthstart" "$CONFIG_FILE")
    printf '%s\n' "${dim}回车保留原值(中括号内为原值)${plain}"
    ask "新名字 [${oname}]:";        read_input name;  name=${name:-$oname}
    ask "新位置 [${oloc}]:";         read_input loc;   loc=${loc:-$oloc}
    ask "新类型 [${otype}]:";        read_input type;  type=${type:-$otype}
    ask "月流量起始日 [${omonth}]:"; read_input month; month=${month:-$omonth}
    [[ "$month" =~ ^([1-9]|[12][0-9]|3[01])$ ]] || { err "月流量起始日必须为 1–31"; return; }
    [[ "$name" =~ [^[:space:]] ]] || { err "名字不能为空"; return; }
    jq -e --arg n "$name" --argjson idx "$idx" '.servers | to_entries | any(.key != $idx and .value.name == $n)' "$CONFIG_FILE" >/dev/null && { err "节点名字已存在"; return; }
    if [ "$name" = "$oname" ] && [ "$loc" = "$oloc" ] && [ "$type" = "$otype" ] && [ "$month" = "$omonth" ]; then
        info "未做任何更新，直接返回"
        return
    fi

    tmp=$(mktemp)
    jq --arg n "$name" --arg l "$loc" --arg t "$type" --arg m "$month" \
       ".servers[$idx].name=\$n | .servers[$idx].location=\$l | .servers[$idx].type=\$t | .servers[$idx].monthstart=\$m | .servers |= sort_by(.name)" \
       "$CONFIG_FILE" > "$tmp" && mv "$tmp" "$CONFIG_FILE" || { err "写入失败"; rm -f "$tmp"; return; }

    save_node_change || return 1
    ok "更新成功"
    list_nodes
}

toggle_node_hidden() {
    ensure_config
    list_nodes
    local count idx name hidden tmp label
    count=$(jq '.servers | length' "$CONFIG_FILE")
    [ "$count" -eq 0 ] && return
    echo
    ask "请输入要切换 Web 显示状态的节点编号:"; read_input idx
    [[ "$idx" =~ ^[0-9]+$ ]] || { err "无效输入"; return; }
    [ "$idx" -ge "$count" ] && { err "编号超出范围"; return; }
    name=$(jq -r ".servers[$idx].name" "$CONFIG_FILE")
    hidden=$(jq -r ".servers[$idx].hidden // false" "$CONFIG_FILE")
    if [[ "$hidden" == true ]]; then hidden=false; label="显示"; else hidden=true; label="隐藏"; fi
    tmp=$(mktemp)
    jq --argjson h "$hidden" ".servers[$idx].hidden=\$h" "$CONFIG_FILE" > "$tmp" \
        && mv "$tmp" "$CONFIG_FILE" || { err "更新隐藏状态失败"; rm -f "$tmp"; return; }
    save_node_change || return 1
    ok "节点 ${bold}${name}${plain} 已设为${label}"
    list_nodes
}

menu_loop() {
    ensure_config
    while true; do
        clear 2>/dev/null
        banner
        printf '%s\n' "${dim}  部署与更新帮助: bash $0 help${plain}"
        list_nodes
        echo
        printf '%s\n' "  ${bold}操作菜单${plain}"
        printf '%s\n' "    ${green}1${plain}. 查看节点      ${green}2${plain}. 添加节点"
        printf '%s\n' "    ${green}3${plain}. 删除节点      ${green}4${plain}. 更新节点"
        printf '%s\n' "    ${green}5${plain}. 切换 Web 隐藏状态"
        printf '%s\n' "    ${green}0${plain}. 退出"
        echo
        ask "请输入操作编号:"; read_input op
        case "$op" in
            1) view_node;   pause ;;
            2) add_node;    pause ;;
            3) remove_node; pause ;;
            4) update_node; pause ;;
            5) toggle_node_hidden; pause ;;
            0) echo; ok "再见 👋"; exit 0 ;;
            *) echo; err "无效输入，已退出"; exit 1 ;;
        esac
    done
}

deploy_cloudflare() {
    command -v node >/dev/null 2>&1 || { err "部署需要 Node.js 22+ 和 npm"; return 1; }
    local argument
    for argument in "$@"; do
        [ "$argument" = "--plan" ] || { err "部署参数仅支持 --plan"; return 1; }
    done
    if [ "${1:-}" != "--plan" ] && { [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ] || [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; }; then
        err "请在 ${SSS_ENV_FILE} 填写 CLOUDFLARE_ACCOUNT_ID 和 CLOUDFLARE_API_TOKEN"
        return 1
    fi
    local source_dir="$SCRIPT_DIR" stage="" origin owner repo ref result
    if [ ! -f "$source_dir/scripts/deploy-cloudflare.mjs" ]; then
        if [ "${1:-}" = "--plan" ]; then
            info "预览：从 ${GITHUB_RAW_URL} 下载完整源码，再创建/更新 CF Worker 与 D1；使用配置 ${SSS_ENV_FILE}"
            return 0
        fi
        case "$GITHUB_RAW_URL" in
            https://raw.githubusercontent.com/*) ;;
            *) err "自动部署的 GitHub 源必须是 raw.githubusercontent.com 地址"; return 1 ;;
        esac
        command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1 || {
            err "下载部署源码需要 curl 和 tar"; return 1;
        }
        origin=${GITHUB_RAW_URL#https://raw.githubusercontent.com/}
        owner=${origin%%/*}; origin=${origin#*/}
        repo=${origin%%/*}; ref=${origin#*/}
        [ -n "$owner" ] && [ -n "$repo" ] && [ "$ref" != "$repo" ] || { err "GitHub 源地址无效"; return 1; }
        stage=$(mktemp -d) || return 1
        source_dir="$stage/source"
        mkdir -p "$source_dir"
        info "正在下载发布源码 (${owner}/${repo}/${ref})…"
        if ! curl -fsSL --max-time 120 "https://codeload.github.com/${owner}/${repo}/tar.gz/${ref}" -o "$stage/source.tar.gz" ||
           ! tar -xzf "$stage/source.tar.gz" -C "$source_dir" --strip-components=1 ||
           [ ! -f "$source_dir/scripts/deploy-cloudflare.mjs" ]; then
            err "部署源码下载失败或分支尚未发布，请检查 GITHUB_RAW_URL"
            rm -rf "$stage"
            return 1
        fi
    fi
    node "$source_dir/scripts/deploy-cloudflare.mjs" --settings "$SSS_ENV_FILE" "$@"
    result=$?
    [ -z "$stage" ] || rm -rf "$stage"
    return "$result"
}

node_ready() {
    local version
    command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 || return 1
    version=$(node --version 2>/dev/null) || return 1
    [[ "$version" =~ ^v([0-9]+)\. ]] && [ "${BASH_REMATCH[1]}" -ge 22 ] || return 1
    npm --version >/dev/null 2>&1
}

install_user_node() {
    local platform="$1" architecture stage line pattern release="" checksum="" actual parent
    case "$(uname -m)" in
        x86_64|amd64) architecture=x64 ;;
        arm64|aarch64) architecture=arm64 ;;
        *) err "自动安装 Node.js 仅支持 x64/arm64，请手动安装 Node.js 22+ 和 npm"; return 1 ;;
    esac
    command -v tar >/dev/null 2>&1 || { err "缺少 tar，请先安装"; return 1; }
    command -v shasum >/dev/null 2>&1 || command -v sha256sum >/dev/null 2>&1 || {
        err "缺少 SHA-256 校验工具，请先安装 shasum 或 sha256sum"; return 1;
    }
    parent=$(dirname "$SSS_NODE_PATH")
    mkdir -p "$parent" || return 1
    stage=$(mktemp -d "$parent/.node-install.XXXXXX") || return 1
    info "从 nodejs.org 下载 Node.js 22 和 npm，安装到当前用户目录…"
    if ! curl -fsSL --connect-timeout 20 --max-time 120 https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$stage/SHASUMS256.txt"; then
        err "Node.js 校验清单下载失败"; rm -rf "$stage"; return 1
    fi
    pattern="^([a-fA-F0-9]{64})[[:space:]]+node-(v22\.[0-9]+\.[0-9]+)-${platform}-${architecture}\.tar\.gz$"
    while IFS= read -r line; do
        if [[ "$line" =~ $pattern ]]; then
            checksum=${BASH_REMATCH[1]}; release="node-${BASH_REMATCH[2]}-${platform}-${architecture}"
            break
        fi
    done < "$stage/SHASUMS256.txt"
    if [ -z "$release" ] || ! curl -fsSL --connect-timeout 20 --max-time 300 \
        "https://nodejs.org/dist/latest-v22.x/$release.tar.gz" -o "$stage/node.tar.gz"; then
        err "Node.js 安装包下载失败或未找到适配版本"; rm -rf "$stage"; return 1
    fi
    if command -v sha256sum >/dev/null 2>&1; then
        actual=$(sha256sum "$stage/node.tar.gz")
    else
        actual=$(shasum -a 256 "$stage/node.tar.gz")
    fi
    if [ "${actual%% *}" != "$checksum" ]; then
        err "Node.js SHA-256 校验失败，未安装"; rm -rf "$stage"; return 1
    fi
    if ! tar -xzf "$stage/node.tar.gz" -C "$stage" ||
       ! (export PATH="$stage/$release/bin:$PATH"; node_ready); then
        err "Node.js 安装包无法运行，现有安装保持不变"; rm -rf "$stage"; return 1
    fi
    if [ -e "$SSS_NODE_PATH" ]; then
        mv "$SSS_NODE_PATH" "$stage/previous" || { rm -rf "$stage"; return 1; }
    fi
    if ! mv "$stage/$release" "$SSS_NODE_PATH"; then
        [ ! -e "$stage/previous" ] || mv "$stage/previous" "$SSS_NODE_PATH"
        rm -rf "$stage"; return 1
    fi
    rm -rf "$stage"
    export PATH="$SSS_NODE_PATH/bin:$PATH"
    hash -r
}

setup_dependencies() {
    local platform tool missing=() administrator=()
    for tool in curl jq; do
        command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
    done
    case "$(uname -s)" in
        Darwin)
            platform=darwin
            if [ "${#missing[@]}" -gt 0 ]; then
                command -v brew >/dev/null 2>&1 || {
                    err "自动安装 ${missing[*]} 需要 Homebrew，请先从 https://brew.sh 安装 Homebrew 后重试 init"; return 1;
                }
                info "使用 Homebrew 安装缺少的工具: ${missing[*]}"
                brew install "${missing[@]}" || return 1
            fi
            ;;
        Linux)
            platform=linux
            if [ "${#missing[@]}" -gt 0 ]; then
                command -v apt-get >/dev/null 2>&1 || { err "自动安装依赖仅支持 Ubuntu/Debian 的 apt-get"; return 1; }
                if [ "$EUID" -ne 0 ]; then
                    command -v sudo >/dev/null 2>&1 || { err "安装 ${missing[*]} 需要 sudo 或管理员先安装这些工具"; return 1; }
                    administrator=(sudo)
                    info "安装系统工具 ${missing[*]} 需要 sudo，可能提示输入系统密码；Node.js 安装不需要 sudo。"
                fi
                for tool in "${missing[@]}"; do
                    if [ "$tool" = curl ]; then missing+=(ca-certificates); break; fi
                done
                "${administrator[@]}" apt-get update &&
                    "${administrator[@]}" apt-get install -y "${missing[@]}" || return 1
            fi
            ;;
        *) err "自动初始化仅支持 macOS、Ubuntu 和 Debian"; return 1 ;;
    esac
    for tool in curl jq; do
        command -v "$tool" >/dev/null 2>&1 || { err "$tool 安装后仍不可用"; return 1; }
    done
    node_ready || install_user_node "$platform" || return 1
    ok "依赖已就绪: curl、jq、Node.js 22+、npm"
}

init_settings() {
    [ ! -e "$SSS_ENV_FILE" ] || [ -f "$SSS_ENV_FILE" ] || { err "配置路径不是文件: $SSS_ENV_FILE"; return 1; }
    setup_dependencies || return 1
    [ ! -e "$SSS_ENV_FILE" ] || {
        chmod 600 "$SSS_ENV_FILE" || return 1
        info "配置文件已存在，已保留: $SSS_ENV_FILE"; return 0;
    }
    mkdir -p "$(dirname "$SSS_ENV_FILE")" || return 1
    (umask 077; cat > "$SSS_ENV_FILE" <<'SETTINGS'
# 首次部署必填；仅管理已有节点时可留空。
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=

# 默认资源名称；首次部署会自动写回 D1 ID、Worker URL 和管理 Token。
SSS_WORKER_NAME=sss-server-status
SSS_D1_NAME=sss-server-status
SSS_D1_ID=
SSS_WORKER_URL=
SSS_MANAGEMENT_TOKEN=

# 可选通知；两项同时填写。留空时部署为关闭通知。
TG_BOT_TOKEN=
TG_CHAT_ID=

# 与本分支一致的 GitHub 发布源。
GITHUB_RAW_URL=https://raw.githubusercontent.com/lidalao/ServerStatus/feature/cloudflare-monitor
SETTINGS
    ) || return 1
    ok "已生成 ${SSS_ENV_FILE}，填好后执行 bash $0 --deploy"
}

show_help() {
    cat <<HELP
用法: bash $0 [init | deploy [--plan] | update [--plan] | help]
配置文件: $SSS_ENV_FILE
支持系统: macOS、Ubuntu、Debian

命令说明
  无参数
    只进入节点管理菜单，不执行 CF 部署或更新。
    需要 Bash、curl、jq，以及 SSS_WORKER_URL、SSS_MANAGEMENT_TOKEN。
    不需要 Node.js、CF API Token 或登录 CF。

  init
    自动检查并安装缺少的 curl、jq、Node.js 22+ 和 npm。
    macOS 的系统工具通过 Homebrew 安装（需要已安装 Homebrew）；
    Ubuntu/Debian 通过 apt-get 安装，普通用户可能需要 sudo。
    Node.js 22 和 npm 从官网获取并验证 SHA-256，安装到 ~/.local/share/sss/node，
    后续脚本自动使用该运行时，不修改 shell 配置或替换系统 Node.js。
    在配置文件路径生成权限为 600 的 .env 模板；已有文件保留，重复 init 可补齐依赖。
    首次部署前填写 CLOUDFLARE_ACCOUNT_ID 和 CLOUDFLARE_API_TOKEN。
    仅管理已有服务时，只填写 Worker 地址与管理 Token 即可。

  deploy [--plan]
    首次部署 CF 上的 Web、API、D1 和通知任务，也可用于部署失败后重试。
    自动检查构建、查找或创建 D1、应用数据库迁移、发布 Worker 和 Secrets，
    验证管理 API，并将 D1 ID、Worker 地址与管理 Token 写回 .env。
    已保存的 D1 和管理 Token 会复用，节点配置不会清空。
    需要 Node.js 22+、npm、CF Account ID 和具备对应权限的 CF API Token。
    CF Token 权限: Workers Scripts 编辑、D1 编辑。
    CF 账号需已启用 workers.dev 子域名，不需要 wrangler login。

  update [--plan]
    更新已有 CF 服务，包括 Web、API、数据库迁移和通知配置。
    除部署所需参数外，.env 必须保留 SSS_D1_ID、SSS_WORKER_URL、
    SSS_MANAGEMENT_TOKEN；不会自动重新生成管理凭据。
    在源码目录中发布当前本地源码，不自动 git pull。
    单独下载的脚本会从 GITHUB_RAW_URL 获取源码，需要 curl 和 tar。
    deploy 同样遵循上述源码选择规则；CF 发布不会更新 GitHub 或 VPS Agent。

  help / --help / -h
    显示本帮助，不访问 CF、不部署、不修改配置。

参数与别名
  --plan                 仅预览步骤，不联网、不写配置、不部署。
                         update --plan 仍需已有部署参数。
  --init / --deploy / --update
                         分别等同于 init / deploy / update。

节点管理菜单（运行时不带命令）
  1 查看节点             查看配置和 VPS Agent 安装命令。
  2 添加节点             自动保存到远端，成功后显示 VPS Agent 安装命令。
  3 删除节点             确认后自动保存到远端，该节点上报将被拒绝。
                         VPS 上已有 Agent 需另行使用安装器卸载。
  4 更新节点             修改名字、位置、类型、月流量起始日（1–31）。
  5 切换 Web 隐藏状态    仅影响网页显示，离线节点也隐藏；上报和通知继续运行。
  0 退出                 退出节点管理。
  添加、删除、修改、隐藏均自动提交，远端确认成功后再回显结果。
  查看不写入配置。版本冲突不会覆盖他人修改；失败后重新读取远端状态。
  节点操作只更新配置，不重新发布 Worker。

配置说明（全部放在同一个 .env）
  CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN
                         CF 账号与部署 Token，仅部署/更新需要。
  SSS_WORKER_NAME        Worker 名称，默认 sss-server-status。
  SSS_D1_NAME            D1 名称，默认 sss-server-status。
  SSS_D1_ID              D1 数据库 ID，部署时自动保存，更新时保留。
  SSS_WORKER_URL         Worker 地址，首次部署自动保存；管理节点需要。
  SSS_MANAGEMENT_TOKEN   节点管理 Token，首次部署自动生成；与 CF API Token 不同。
  TG_BOT_TOKEN / TG_CHAT_ID
                         Telegram 通知，两项同时填写；同时留空关闭通知。
                         修改后执行 update，作为 Worker Secrets 发布。
  GITHUB_RAW_URL         GitHub 源码/Agent 下载来源，可指定已发布的分支或标签。
  SSS_ENV_FILE           用环境变量指定另一配置文件，示例见下方。

  默认读取脚本同目录 .env；环境变量优先于文件值。
  文件格式为单行 KEY=VALUE，可带一对引号；不执行命令、不展开变量、
  不支持行尾注释。没有 .env 时才回退读取 ~/.config/sss/remote.env
  （设置 XDG_CONFIG_HOME 时使用该目录下的 sss/remote.env）。

常用示例
  bash $0 init
  # 编辑 .env，填写 CF 参数；可选填写 Telegram 参数
  bash $0 deploy --plan
  bash $0 deploy
  bash $0                       # 日常管理节点
  bash $0 update                # 发布当前源码及更新后的通知配置
  SSS_ENV_FILE=/path/to/sss.env bash $0
HELP
}

# ================= 入口 =================
case "${1:-}" in
    init|--init) init_settings; exit $? ;;
    deploy|--deploy|update|--update)
        action="$1"
        if [[ "$action" = update || "$action" = --update ]] && { [ -z "${SSS_D1_ID:-}" ] || [ -z "$SSS_WORKER_URL" ] || [ -z "$SSS_MANAGEMENT_TOKEN" ]; }; then
            err "更新需要 .env 中已保存的 SSS_D1_ID、SSS_WORKER_URL 和 SSS_MANAGEMENT_TOKEN，请先完成首次部署"
            exit 1
        fi
        shift
        deploy_cloudflare "$@"
        exit $?
        ;;
    help|--help|-h)
        show_help
        exit 0
        ;;
    "") ;;
    *) err "未知参数，请使用 --help"; exit 1 ;;
esac
clear 2>/dev/null
banner
pre_check
menu_loop
