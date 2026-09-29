#!/usr/bin/env python3
# coding: utf-8
# Create by : https://github.com/cppla/ServerStatus
# Linux / Python 3 Agent：向 Cloudflare Worker 通过 HTTPS 上报。
# 丢包率检测目标可通过下面的 CU / CT / CM 配置调整。
AGENT_PROTOCOL = "sss-worker-https-v1"
USER = ""
PASSWORD = ""
INTERVAL = 1
REPORT_INTERVAL = 15
WORKER_URL = ""
PROBEPORT = 80
PROBE_PROTOCOL_PREFER = "ipv4"  # ipv4, ipv6
PING_PACKET_HISTORY_LEN = 100
CU = "cu.tz.cloudcpp.com"
CT = "ct.tz.cloudcpp.com"
CM = "cm.tz.cloudcpp.com"

import socket
import time
import timeit
import re
import os
import sys
import json
import errno
import subprocess
import threading
from urllib.request import Request, urlopen
from queue import Queue

def get_uptime():
    with open('/proc/uptime', 'r') as f:
        uptime = f.readline().split('.', 2)
        return int(uptime[0])

def get_memory():
    re_parser = re.compile(r'^(?P<key>\S*):\s*(?P<value>\d*)\s*kB')
    result = dict()
    for line in open('/proc/meminfo'):
        match = re_parser.match(line)
        if not match:
            continue
        key, value = match.groups(['key', 'value'])
        result[key] = int(value)
    MemTotal = float(result['MemTotal'])
    MemUsed = MemTotal-float(result['MemFree'])-float(result['Buffers'])-float(result['Cached'])-float(result['SReclaimable'])
    SwapTotal = float(result['SwapTotal'])
    SwapFree = float(result['SwapFree'])
    return int(MemTotal), int(MemUsed), int(SwapTotal), int(SwapFree)

def get_hdd():
    p = subprocess.check_output(['df', '-Tlm', '--total', '-t', 'ext4', '-t', 'ext3', '-t', 'ext2', '-t', 'reiserfs', '-t', 'jfs', '-t', 'ntfs', '-t', 'fat32', '-t', 'btrfs', '-t', 'fuseblk', '-t', 'zfs', '-t', 'simfs', '-t', 'xfs']).decode("Utf-8")
    total = p.splitlines()[-1]
    used = total.split()[3]
    size = total.split()[2]
    return int(size), int(used)

def get_time():
    with open("/proc/stat", "r") as f:
        time_list = f.readline().split(' ')[2:6]
        for i in range(len(time_list))  :
            time_list[i] = int(time_list[i])
        return time_list

def delta_time():
    x = get_time()
    time.sleep(INTERVAL)
    y = get_time()
    for i in range(len(x)):
        y[i]-=x[i]
    return y

def get_cpu():
    t = delta_time()
    st = sum(t)
    if st == 0:
        st = 1
    result = 100-(t[len(t)-1]*100.00/st)
    return round(result, 1)

def liuliang():
    NET_IN = 0
    NET_OUT = 0
    with open('/proc/net/dev') as f:
        for line in f.readlines():
            netinfo = re.findall(r'([^\s]+):[\s]{0,}(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)', line)
            if netinfo:
                if netinfo[0][0] == 'lo' or 'tun' in netinfo[0][0] \
                        or 'docker' in netinfo[0][0] or 'veth' in netinfo[0][0] \
                        or 'br-' in netinfo[0][0] or 'vmbr' in netinfo[0][0] \
                        or 'vnet' in netinfo[0][0] or 'kube' in netinfo[0][0]:
                    continue
                else:
                    NET_IN += int(netinfo[0][1])
                    NET_OUT += int(netinfo[0][9])
    return NET_IN, NET_OUT

def tupd():
    # These optional fields are intentionally not sampled; retain dashboard compatibility.
    return 0, 0, 0, 0

def get_network(ip_version):
    if(ip_version == 4):
        HOST = "ipv4.google.com"
    elif(ip_version == 6):
        HOST = "ipv6.google.com"
    try:
        socket.create_connection((HOST, 80), 2).close()
        return True
    except:
        return False

lostRate = {
    '10010': 0.0,
    '189': 0.0,
    '10086': 0.0
}
pingTime = {
    '10010': 0,
    '189': 0,
    '10086': 0
}
netSpeed = {
    'netrx': 0.0,
    'nettx': 0.0,
    'clock': 0.0,
    'diff': 0.0,
    'avgrx': 0,
    'avgtx': 0
}

def _ping_thread(host, mark, port):
    lostPacket = 0
    packet_queue = Queue(maxsize=PING_PACKET_HISTORY_LEN)

    IP = host
    if host.count(':') < 1:     # if not plain ipv6 address, means ipv4 address or hostname
        try:
            if PROBE_PROTOCOL_PREFER == 'ipv4':
                IP = socket.getaddrinfo(host, None, socket.AF_INET)[0][4][0]
            else:
                IP = socket.getaddrinfo(host, None, socket.AF_INET6)[0][4][0]
        except Exception:
                pass

    while True:
        if packet_queue.full():
            if packet_queue.get() == 0:
                lostPacket -= 1
        try:
            b = timeit.default_timer()
            socket.create_connection((IP, port), timeout=1).close()
            pingTime[mark] = int((timeit.default_timer() - b) * 1000)
            packet_queue.put(1)
        except socket.error as error:
            if error.errno == errno.ECONNREFUSED:
                pingTime[mark] = int((timeit.default_timer() - b) * 1000)
                packet_queue.put(1)
            #elif error.errno == errno.ETIMEDOUT:
            else:
                lostPacket += 1
                packet_queue.put(0)

        if packet_queue.qsize() > 30:
            lostRate[mark] = float(lostPacket) / packet_queue.qsize()

        time.sleep(INTERVAL)

def _net_speed():
    while True:
        rx, tx = liuliang()
        now_clock = time.monotonic()
        elapsed = now_clock - netSpeed["clock"]
        if netSpeed["clock"] and elapsed > 0:
            netSpeed["netrx"] = max(0, int((rx - netSpeed["avgrx"]) / elapsed))
            netSpeed["nettx"] = max(0, int((tx - netSpeed["avgtx"]) / elapsed))
        else:
            netSpeed["netrx"] = netSpeed["nettx"] = 0
        netSpeed.update(clock=now_clock, diff=elapsed, avgrx=rx, avgtx=tx)
        time.sleep(INTERVAL)

def get_realtime_date():
    t1 = threading.Thread(
        target=_ping_thread,
        kwargs={
            'host': CU,
            'mark': '10010',
            'port': PROBEPORT
        }
    )
    t2 = threading.Thread(
        target=_ping_thread,
        kwargs={
            'host': CT,
            'mark': '189',
            'port': PROBEPORT
        }
    )
    t3 = threading.Thread(
        target=_ping_thread,
        kwargs={
            'host': CM,
            'mark': '10086',
            'port': PROBEPORT
        }
    )
    t4 = threading.Thread(
        target=_net_speed,
    )
    for thread in (t1, t2, t3, t4):
        thread.daemon = True
    t1.start()
    t2.start()
    t3.start()
    t4.start()

network_online = {4: False, 6: False}

def collect_metrics(timer=0):
    CPU = get_cpu()
    NET_IN, NET_OUT = liuliang()
    Uptime = get_uptime()
    Load_1, Load_5, Load_15 = os.getloadavg()
    MemoryTotal, MemoryUsed, SwapTotal, SwapFree = get_memory()
    HDDTotal, HDDUsed = get_hdd()

    array = {}
    families = (4, 6)
    if timer <= 0:
        for family in families:
            network_online[family] = get_network(family)
        timer = 10
    else:
        timer = max(0, timer - INTERVAL)
    for family in families:
        array['online' + str(family)] = network_online[family]

    array['uptime'] = Uptime
    array['load_1'] = Load_1
    array['load_5'] = Load_5
    array['load_15'] = Load_15
    array['memory_total'] = MemoryTotal
    array['memory_used'] = MemoryUsed
    array['swap_total'] = SwapTotal
    array['swap_used'] = SwapTotal - SwapFree
    array['hdd_total'] = HDDTotal
    array['hdd_used'] = HDDUsed
    array['cpu'] = CPU
    array['network_rx'] = netSpeed.get("netrx")
    array['network_tx'] = netSpeed.get("nettx")
    array['network_in'] = NET_IN
    array['network_out'] = NET_OUT
    array['ip_status'] = True
    array['ping_10010'] = lostRate.get('10010') * 100
    array['ping_189'] = lostRate.get('189') * 100
    array['ping_10086'] = lostRate.get('10086') * 100
    array['time_10010'] = pingTime.get('10010')
    array['time_189'] = pingTime.get('189')
    array['time_10086'] = pingTime.get('10086')
    array['tcp'], array['udp'], array['process'], array['thread'] = tupd()
    return array, timer

def post_worker_report(metrics):
    payload = json.dumps({'username': USER, 'password': PASSWORD, 'metrics': metrics})
    request = Request(WORKER_URL.rstrip('/') + '/api/agent/report', data=payload.encode("utf-8"))
    request.add_header('Content-Type', 'application/json')
    response = urlopen(request, timeout=20)
    response.read()
    response.close()

def configure(arguments):
    string_keys = {'USER', 'PASSWORD', 'WORKER_URL'}
    integer_keys = {'INTERVAL', 'REPORT_INTERVAL'}
    for argument in arguments:
        key, separator, value = argument.partition('=')
        if not separator or key not in string_keys | integer_keys:
            raise ValueError('Unknown Agent argument: ' + key)
        if key in integer_keys:
            value = int(value)
            if value <= 0:
                raise ValueError('Invalid Agent argument: ' + key)
        globals()[key] = value
    if not WORKER_URL.startswith(('https://', 'http://')):
        raise ValueError('WORKER_URL must be an HTTP(S) URL')

if __name__ == '__main__':
    configure(sys.argv[1:])
    socket.setdefaulttimeout(30)
    get_realtime_date()
    last_report = 0
    timer = 0
    while True:
        try:
            metrics, timer = collect_metrics(timer=timer)
            now = time.time()
            if now - last_report >= REPORT_INTERVAL:
                post_worker_report(metrics)
                last_report = now
        except KeyboardInterrupt:
            raise
        except Exception as e:
            print("Worker report failed:", e)
            time.sleep(3)
