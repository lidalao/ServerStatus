#!/bin/bash

# Cloudflare ServerStatus Agent installer.
# Target: Linux VPS (Ubuntu/Debian), Python 3 and systemd user services.
# Node administration runs separately via sss.sh on a management machine.

# The downloaded installer is disposable. Resolve its path before any work,
# and preserve the operation's exit status when removing only this script.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
    SSS_INSTALLER_FILE="$(cd -- "$(dirname -- "$0")" && pwd)/$(basename -- "$0")"
    cleanup_installer() {
        local result=$?
        rm -f -- "$SSS_INSTALLER_FILE" || echo "无法删除安装脚本，请手动删除: $SSS_INSTALLER_FILE" >&2
        return "$result"
    }
    trap cleanup_installer EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
fi

SSS_AGENT_PATH="$HOME/.local/share/sss/agent"
SSS_AGENT_SERVICE="$HOME/.config/systemd/user/sss-agent.service"
# An explicit source overrides the source saved by the previous installation.
if [ -z "${GITHUB_RAW_URL:-}" ] && [ -f "$SSS_AGENT_PATH/.env" ]; then
    while IFS='=' read -r key value; do
        [ "$key" = GITHUB_RAW_URL ] && GITHUB_RAW_URL=${value%$'\r'}
    done < "$SSS_AGENT_PATH/.env"
fi
GITHUB_RAW_URL="${GITHUB_RAW_URL:-https://raw.githubusercontent.com/lidalao/ServerStatus/feature/cloudflare-monitor}"

red='\033[0;31m'
green='\033[0;32m'
yellow='\033[0;33m'
plain='\033[0m'
export PATH=$PATH:/usr/local/bin

pre_check() {
    command -v systemctl >/dev/null 2>&1 || { echo "不支持此系统：未找到 systemctl 命令"; exit 1; }
    command -v python3 >/dev/null 2>&1 || { echo "缺少 python3，请联系 VPS 管理员安装"; exit 1; }
}

confirm_root_install() {
    [ "$(id -u)" -eq 0 ] || return 0
    local answer
    echo "当前以 root 执行；继续后 Agent 将安装在 root 的用户目录，并以 root 权限运行。"
    printf '确认以 root 安装/更新 Agent? [y/N]: '
    if ! read -r answer; then
        echo "未收到确认，已取消安装；现有安装未修改"
        return 1
    fi
    case "$answer" in
        y|Y|yes|YES) return 0 ;;
        *) echo "已取消安装；现有安装未修改"; return 1 ;;
    esac
}

install_base() {
    if ! command -v wget >/dev/null 2>&1 && ! command -v curl >/dev/null 2>&1; then
        echo "缺少 wget/curl，请在 VPS 上安装其中一个下载工具"
        return 1
    fi
}

download_file() {
    local url="$1" destination="$2"
    if command -v wget >/dev/null 2>&1; then
        wget -qO "$destination" "$url"
    else
        curl -fsSL "$url" -o "$destination"
    fi
}

prepare_user_environment() {
    local runtime="/run/user/$(id -u)"
    # sudo/su and non-login shells may inherit another user's session variables.
    if [ ! -d "$runtime" ] && [ -n "${XDG_RUNTIME_DIR:-}" ] &&
       [ -d "$XDG_RUNTIME_DIR" ] && [ -O "$XDG_RUNTIME_DIR" ]; then
        runtime="$XDG_RUNTIME_DIR"
    fi
    if [ -d "$runtime" ] && [ ! -O "$runtime" ]; then
        echo "用户运行目录不属于当前用户，拒绝连接: $runtime"
        return 1
    fi
    export XDG_RUNTIME_DIR="$runtime"
    unset DBUS_SESSION_BUS_ADDRESS
    if [ -S "$runtime/bus" ]; then
        [ -O "$runtime/bus" ] || { echo "用户 D-Bus socket 不属于当前用户，拒绝连接"; return 1; }
        export DBUS_SESSION_BUS_ADDRESS="unix:path=$runtime/bus"
    fi
}

user_service_diagnostic() {
    local uid username
    uid=$(id -u); username=$(id -un)
    echo -e "${red}无法连接当前用户的 systemd manager；不是 Worker 地址或节点凭据错误。${plain}"
    printf '当前用户: %s (UID=%s)，运行目录: %s\n' "$username" "$uid" "${XDG_RUNTIME_DIR:-未设置}"
    echo "已按当前用户重新设置会话环境；若仍失败，请使用该用户直接 SSH 登录，检查用户 manager 和 D-Bus。"
    printf '检查命令: loginctl show-user %q -p Linger -p State\n' "$username"
    printf '主机管理员可执行: loginctl enable-linger %q\n' "$username"
    printf '主机管理员可执行: systemctl start user@%s.service\n' "$uid"
    echo "若用户 manager 启动失败，管理员需检查 libpam-systemd/dbus-user-session 和 user@ 服务日志。"
    echo "无法取得主机授权或启动用户 manager；未修改 /run/user 权限，也未停止旧版系统 Agent。"
}

wait_user_manager() {
    local attempt
    for attempt in 1 2 3 4 5 6 7 8 9 10; do
        prepare_user_environment || return 1
        systemctl --user daemon-reload >/dev/null 2>&1 && return 0
        sleep 0.2
    done
    return 1
}

recover_user_manager() {
    local uid username administrator=()
    uid=$(id -u); username=$(id -un)
    command -v loginctl >/dev/null 2>&1 || return 1
    echo "当前用户 manager 不可用，正在自动修复 $username (UID=$uid) 的 linger 和服务…"
    # First try the current user's logind policy without an authorization prompt.
    if loginctl --no-ask-password enable-linger "$username" >/dev/null 2>&1; then
        wait_user_manager && return 0
    fi
    if [ "$uid" -ne 0 ]; then
        command -v sudo >/dev/null 2>&1 || return 1
        echo "主机修复需要一次 sudo 授权，可能提示系统密码；Agent 仍以当前用户运行。"
        administrator=(sudo)
    fi
    "${administrator[@]}" loginctl enable-linger "$username" &&
        "${administrator[@]}" systemctl start "user@$uid.service" || return 1
    wait_user_manager
}

ensure_user_manager() {
    prepare_user_environment || { user_service_diagnostic; return 1; }
    systemctl --user daemon-reload >/dev/null 2>&1 && return 0
    recover_user_manager && return 0
    user_service_diagnostic
    return 1
}

user_linger_enabled() {
    [ "$(loginctl show-user "$(id -un)" -p Linger --value 2>/dev/null)" = yes ]
}

ensure_user_linger() {
    local username administrator=()
    username=$(id -un)
    command -v loginctl >/dev/null 2>&1 || {
        echo "未找到 loginctl，无法确认 Agent 在注销后持续运行；未修改安装"
        return 1
    }
    user_linger_enabled && return 0
    echo "正在启用当前用户 linger，确保 Agent 在 SSH 退出和重启后继续运行…"
    if loginctl --no-ask-password enable-linger "$username" >/dev/null 2>&1 && user_linger_enabled; then
        return 0
    fi
    if [ "$(id -u)" -ne 0 ]; then
        command -v sudo >/dev/null 2>&1 || {
            echo "无法启用 linger，请主机管理员执行: loginctl enable-linger $username；未修改安装"
            return 1
        }
        echo "启用 linger 需要一次 sudo 主机授权；Agent 仍以当前用户运行。"
        administrator=(sudo)
    fi
    if "${administrator[@]}" loginctl enable-linger "$username" && user_linger_enabled; then
        return 0
    fi
    echo "无法确认 Linger=yes；为避免 SSH 退出后停止上报，未修改安装。"
    return 1
}

activate_user_service() {
    ensure_user_manager || return 1
    systemctl --user enable --now sss-agent && systemctl --user restart sss-agent || {
        echo -e "${red}Agent 文件已安装，但 user service 启动失败。可检查: systemctl --user status sss-agent${plain}"
        return 1
    }
}

modify_agent_config() {
    echo -e "> 修改Agent配置"

    local download_base="$GITHUB_RAW_URL/agent"
    install -d -m 0700 "$(dirname "$SSS_AGENT_SERVICE")"
    if ! download_file "$download_base/sss-agent.service" "$SSS_AGENT_SERVICE"; then
        echo -e "${red}Agent 服务配置下载失败，请检查本机能否连接 ${download_base}${plain}"
        return 1
    fi

    [ $# -eq 4 ] && [ "$1" = "--worker" ] || {
        echo "用法: $0 --worker <Worker URL> <用户名> <密码>"
        return 1
    }
    sss_worker_url=$2
    sss_user=$3
    sss_pass=$4

    python3 - "$SSS_AGENT_SERVICE" "$sss_user" "$sss_pass" "$sss_worker_url" <<'PY'
import re
import sys

path, username, password, worker_url = sys.argv[1:]
with open(path, "r") as unit_file:
    unit = unit_file.read()
values = dict(zip(('sss_user', 'sss_pass', 'sss_worker_url'), (username, password, worker_url)))
for marker, value in values.items():
    if any(char in value for char in ('\n', '\r', '\0')):
        raise ValueError('Agent configuration cannot contain control characters')
    values[marker] = value.replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%').replace('$', '$$')
unit = re.sub(r'sss_(?:user|pass|worker_url)', lambda match: values[match[0]], unit)
with open(path, "w") as unit_file:
    unit_file.write(unit)
PY
    [ $? -eq 0 ] || { echo -e "${red}Agent 配置写入失败${plain}"; return 1; }
    chmod 600 "$SSS_AGENT_SERVICE"

    echo -e "Agent配置 ${green}修改成功，正在启动用户级服务${plain}"
}

install_agent() {
    confirm_root_install || return 1
    local download_base="$GITHUB_RAW_URL/agent"
    install_base || return 1
    if [ $# -eq 0 ] && [ ! -f "$SSS_AGENT_SERVICE" ]; then
        echo "首次安装请使用节点管理界面打印的安装命令（包含 Worker URL、用户名和密码）"
        return 1
    fi
    ensure_user_manager || return 1
    ensure_user_linger || return 1
    local stage destination_service="$SSS_AGENT_SERVICE"
    stage=$(mktemp -d) || return 1
    chmod 0700 "$stage"
    echo "正在下载并校验 Agent；现有服务保持运行"
    if ! download_file "$download_base/client-linux.py" "$stage/client-linux.py" ||
       ! python3 - "$stage/client-linux.py" <<'CHECK'
import ast, pathlib, sys
module = ast.parse(pathlib.Path(sys.argv[1]).read_text())
protocol = next((node.value.value for node in module.body
                 if isinstance(node, ast.Assign) and isinstance(node.value, ast.Constant)
                 and any(isinstance(target, ast.Name) and target.id == 'AGENT_PROTOCOL' for target in node.targets)), None)
if protocol != 'sss-worker-https-v1':
    raise ValueError('Downloaded Agent is not a compatible Cloudflare HTTPS Agent')
CHECK
    then
        echo "Agent 下载或校验失败，现有安装未修改"
        rm -rf "$stage"
        return 1
    fi
    if [ $# -eq 0 ]; then
        cp "$destination_service" "$stage/sss-agent.service" || { rm -rf "$stage"; return 1; }
    else
        local SSS_AGENT_SERVICE="$stage/sss-agent.service"
        modify_agent_config "$@" || { rm -rf "$stage"; return 1; }
    fi
    install -d -m 0700 "$SSS_AGENT_PATH" "$(dirname "$destination_service")" || { rm -rf "$stage"; return 1; }
    install -m 0600 "$stage/client-linux.py" "$SSS_AGENT_PATH/client-linux.py" &&
        install -m 0600 "$stage/sss-agent.service" "$destination_service"
    local result=$?
    rm -rf "$stage"
    [ "$result" -eq 0 ] || return "$result"
    (umask 077; printf 'GITHUB_RAW_URL=%s\n' "$GITHUB_RAW_URL" > "$SSS_AGENT_PATH/.env") || return 1
    activate_user_service
}

uninstall_agent() {
    ensure_user_manager || return 1
    systemctl --user disable --now sss-agent || {
        echo "无法停止当前用户的 Agent，保留安装文件，请修复用户服务后重试卸载"
        return 1
    }
    rm -rf "$SSS_AGENT_PATH" "$SSS_AGENT_SERVICE"
    systemctl --user daemon-reload >/dev/null 2>&1
}

show_menu() {
    echo -e "
    ${green}Server Status监控管理脚本${plain}
    --- https://github.com/lidalao/ServerStatus ---
    ${green}1.${plain}  安装/更新当前用户的 Agent
    ${green}2.${plain}  卸载当前用户的 Agent
    ${green}0.${plain}  退出脚本
    "
    echo && read -ep "请输入选择 [0-2]: " num

    case "${num}" in
    0)
        exit 0
        ;;
 
    1)
        install_agent
        ;;
    2)
        uninstall_agent && echo -e "${green}卸载Agent完成${plain}"
        ;;
    *)
        echo -e "${red}请输入正确的数字 [0-2]${plain}"
        ;;
    esac
}

pre_check

if [ $# -eq 0 ]; then
    show_menu
elif [ $# -eq 4 ] && [ "$1" = "--worker" ]; then
    install_agent "$@"
else
    echo "用法: $0 --worker <Worker URL> <用户名> <密码>"
    exit 1
fi
