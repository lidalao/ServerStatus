#!/usr/bin/env python3
# coding: utf-8
# Create by : https://github.com/cppla/ServerStatus
# Linux / Python 3 Agent：向 Cloudflare Worker 通过 HTTPS 上报。
# 丢包率检测目标可通过下面的 CU / CT / CM 配置调整。
AGENT_PROTOCOL = "sss-worker-https-v1"
USER = ""
PASSWORD = ""
INTERVAL = 1
REPORT_INTERVAL = 1
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
from urllib.error import HTTPError
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
    request.add_header('Accept', 'application/json')
    request.add_header('User-Agent', 'ServerStatus-Agent/1.0')
    try:
        with urlopen(request, timeout=20) as response:
            body = response.read(4096)
    except HTTPError as error:
        body = error.read(4096).decode('utf-8', 'replace')
        details = ['HTTP ' + str(error.code)]
        code = re.search(r'error code:\s*(1[0-9]{3})', body, re.IGNORECASE)
        if code:
            details.append('Cloudflare error ' + code.group(1))
        if error.headers.get('cf-mitigated') == 'challenge':
            details.append('Cloudflare challenge; Agent API must allow non-browser requests')
        if error.code == 401:
            details.append('check node credentials and whether the node was submitted')
        if error.code == 403:
            details.append('check Cloudflare security/Access rules for the Agent API')
        ray = error.headers.get('cf-ray', '')
        if re.fullmatch(r'[A-Za-z0-9-]{1,80}', ray):
            details.append('CF-Ray=' + ray)
        error.close()
        # Never log arbitrary response bodies, node credentials or request payloads.
        raise RuntimeError('; '.join(details)) from None
    try:
        accepted = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        raise RuntimeError('Worker returned a non-JSON response; check address and Access/challenge rules') from None
    if not isinstance(accepted, dict) or accepted.get('ok') is not True:
        raise RuntimeError('Worker did not acknowledge the Agent report')

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

class AgentWebSocket:
    """Bounded RFC 6455 client using Python's TLS-verifying standard library.

    No shell/pip dependency is required on monitored hosts. Credentials travel
    only in the encrypted upgrade headers, never in a URL or exception message.
    """
    def __init__(self, base_url, username, password):
        from urllib.parse import urlsplit
        import ssl, base64, hashlib
        parsed = urlsplit(base_url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError('Invalid Worker URL')
        if any(c in username + password for c in '\r\n'):
            raise ValueError('Invalid Agent credentials')
        port = parsed.port or (443 if parsed.scheme == 'https' else 80)
        raw = socket.create_connection((parsed.hostname, port), timeout=20)
        self.sock = raw
        self.buffer = bytearray()
        self.fragments = bytearray()
        self.fragment_opcode = None
        try:
            if parsed.scheme == 'https':
                self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=parsed.hostname)
            key = base64.b64encode(os.urandom(16)).decode('ascii')
            host = parsed.netloc
            path = parsed.path.rstrip('/') + '/api/agent/ws'
            request = ('GET ' + path + ' HTTP/1.1\r\nHost: ' + host + '\r\n'
                       'Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n'
                       'Sec-WebSocket-Key: ' + key + '\r\nX-Agent-User: ' + username + '\r\n'
                       'Authorization: Bearer ' + password + '\r\nUser-Agent: ServerStatus-Agent/2.0\r\n\r\n')
            self.sock.sendall(request.encode('utf-8'))
            header = bytearray()
            deadline = time.monotonic() + 20
            while not header.endswith(b'\r\n\r\n'):
                remaining = deadline - time.monotonic()
                if remaining <= 0: raise RuntimeError('WebSocket handshake timed out')
                self.sock.settimeout(remaining)
                chunk = self.sock.recv(1)
                if not chunk:
                    raise RuntimeError('WebSocket handshake closed')
                header.extend(chunk)
                if len(header) > 16384:
                    raise RuntimeError('WebSocket handshake too large')
            lines = header.decode('latin-1').split('\r\n')
            status = lines[0].split(' ')[1]
            if status != '101':
                raise RuntimeError('WebSocket HTTP ' + (status if status.isdigit() else 'invalid'))
            headers = dict((k.strip().lower(), v.strip()) for k, v in
                           (line.split(':', 1) for line in lines[1:] if ':' in line))
            expected = base64.b64encode(hashlib.sha1((key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').encode()).digest()).decode()
            if (headers.get('sec-websocket-accept') != expected or
                    headers.get('upgrade', '').lower() != 'websocket' or
                    'upgrade' not in [v.strip() for v in headers.get('connection', '').lower().split(',')]):
                raise RuntimeError('Invalid WebSocket handshake')
        except Exception:
            self.close()
            raise

    def close(self):
        try: self.sock.close()
        except OSError: pass

    def send_frame(self, payload, opcode=1):
        import struct
        if len(payload) > 32768:
            raise ValueError('Agent report too large')
        mask = os.urandom(4)
        size = len(payload)
        head = bytes([0x80 | opcode, 0x80 | size]) if size < 126 else bytes([0x80 | opcode, 0xfe]) + struct.pack('!H', size)
        masked = bytes(value ^ mask[i % 4] for i, value in enumerate(payload))
        self.sock.settimeout(20)
        self.sock.sendall(head + mask + masked)

    def report(self, metrics):
        self.send_frame(json.dumps({'metrics': metrics}, separators=(',', ':')).encode())

    def receive(self, timeout):
        import struct
        deadline = time.monotonic() + max(0.001, timeout)
        while True:
            if len(self.buffer) >= 2:
                first, second = self.buffer[:2]
                opcode, final = first & 15, bool(first & 128)
                if first & 112 or second & 128 or opcode not in (0, 1, 8, 9, 10):
                    raise RuntimeError('Invalid WebSocket frame')
                size, offset = second & 127, 2
                width = 2 if size == 126 else 8 if size == 127 else 0
                if len(self.buffer) >= offset + width:
                    if width:
                        size = struct.unpack('!H' if width == 2 else '!Q', self.buffer[offset:offset+width])[0]
                        offset += width
                    if size > 65536 or (opcode >= 8 and (not final or size > 125)):
                        raise RuntimeError('WebSocket frame too large or invalid')
                    if len(self.buffer) >= offset + size:
                        payload = bytes(self.buffer[offset:offset+size])
                        del self.buffer[:offset+size]
                        if opcode == 8: raise RuntimeError('WebSocket closed; reconnecting')
                        if opcode == 9:
                            self.send_frame(payload, 10)
                            continue
                        if opcode == 10: continue
                        if opcode == 1:
                            if self.fragment_opcode is not None: raise RuntimeError('Invalid fragmented message')
                            self.fragment_opcode = 1
                        elif self.fragment_opcode is None:
                            raise RuntimeError('Unexpected continuation')
                        self.fragments.extend(payload)
                        if len(self.fragments) > 65536: raise RuntimeError('WebSocket message too large')
                        if final:
                            result = json.loads(self.fragments.decode('utf-8'))
                            self.fragments.clear()
                            self.fragment_opcode = None
                            return result
                        continue
            remaining = deadline - time.monotonic()
            if remaining <= 0: return None
            self.sock.settimeout(remaining)
            try: data = self.sock.recv(4096)
            except socket.timeout: return None
            if not data: raise RuntimeError('WebSocket disconnected')
            self.buffer.extend(data)


def stream_metrics(connection, latest, on_ack):
    seconds, next_report, last_ping, awaiting_ack = 60, 0, time.monotonic(), None
    while True:
        now = time.monotonic()
        if awaiting_ack is not None and now - awaiting_ack > 20:
            raise RuntimeError('WebSocket acknowledgement timed out')
        if now >= next_report and awaiting_ack is None and latest['metrics'] and now - latest['time'] < 10:
            connection.report(latest['metrics'])
            awaiting_ack = now
            next_report = now + seconds
        if now - last_ping >= 30:
            connection.send_frame(b'sss', 9)
            last_ping = now
        control = connection.receive(min(1, max(0.01, next_report - time.monotonic())))
        if isinstance(control, dict) and control.get('type') in ('ack', 'interval'):
            suggested = control.get('seconds')
            if type(suggested) is not int or not 1 <= suggested <= 60:
                raise RuntimeError('Invalid reporting interval')
            new_interval = max(REPORT_INTERVAL, suggested)
            if new_interval != seconds:
                next_report = time.monotonic() if new_interval < seconds else time.monotonic() + new_interval
            seconds = new_interval
            if control['type'] == 'ack':
                awaiting_ack = None
                on_ack()


def run_agent():
    import random
    latest = {'metrics': None, 'time': 0}
    def collect():
        timer = 10**12
        while True:
            try:
                metrics, timer = collect_metrics(timer)
                latest.update(metrics=metrics, time=time.monotonic())
            except Exception as error:
                print('Metric collection failed:', type(error).__name__, flush=True)
                time.sleep(3)
    def probe_network():
        while True:
            for family in (4, 6): network_online[family] = get_network(family)
            time.sleep(10)
    threading.Thread(target=probe_network, daemon=True).start()
    threading.Thread(target=collect, daemon=True).start()
    delay = 1
    while True:
        connection = None
        try:
            connection = AgentWebSocket(WORKER_URL, USER, PASSWORD)
            def acknowledged():
                nonlocal delay
                delay = 1
            stream_metrics(connection, latest, acknowledged)
        except KeyboardInterrupt:
            raise
        except Exception as error:
            # Never print raw remote frames, headers, URLs or credentials.
            detail = str(error) if isinstance(error, RuntimeError) else type(error).__name__
            print('Worker connection failed:', detail, flush=True)
            time.sleep(delay + random.random())
            delay = min(60, delay * 2)
        finally:
            if connection: connection.close()

if __name__ == '__main__':
    configure(sys.argv[1:])
    socket.setdefaulttimeout(30)
    get_realtime_date()
    run_agent()
