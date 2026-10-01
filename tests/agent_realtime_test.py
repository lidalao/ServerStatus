import importlib.util
import json
import socket
import struct
import unittest

spec = importlib.util.spec_from_file_location('sss_agent', 'agent/client-linux.py')
a = importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)

class FramingTests(unittest.TestCase):
    def setUp(self):
        self.client, self.server = socket.socketpair()
        self.addCleanup(self.client.close)
        self.addCleanup(self.server.close)
        self.ws = a.AgentWebSocket.__new__(a.AgentWebSocket)
        self.ws.sock = self.client
        self.ws.buffer = bytearray()
        self.ws.fragments = bytearray()
        self.ws.fragment_opcode = None

    def test_masked_client_frames(self):
        self.ws.report({'network_in': 123, 'network_out': 456})
        frame = self.server.recv(1000)
        self.assertEqual(frame[0], 0x81)
        self.assertTrue(frame[1] & 128)
        size = frame[1] & 127
        mask, payload = frame[2:6], frame[6:]
        self.assertEqual(size, len(payload))
        decoded = bytes(v ^ mask[i % 4] for i, v in enumerate(payload))
        self.assertEqual(json.loads(decoded)['metrics']['network_in'], 123)

    def test_fragmentation_timeout_and_ping(self):
        self.server.sendall(b'\x01\x08{"type":')
        self.assertIsNone(self.ws.receive(.01))
        self.server.sendall(b'\x89\x01x\x80\x06"ack"}')
        self.assertEqual(self.ws.receive(1), {'type': 'ack'})
        self.assertEqual(self.server.recv(100)[0], 0x8a)

    def test_partial_frame_survives_timeout(self):
        self.server.sendall(b'\x81\x02{')
        self.assertIsNone(self.ws.receive(.01))
        self.server.sendall(b'}')
        self.assertEqual(self.ws.receive(1), {})

    def test_oversized_frame_rejected_before_reading_payload(self):
        self.server.sendall(b'\x81\x7f' + struct.pack('!Q', 1000000))
        with self.assertRaises(RuntimeError): self.ws.receive(1)

    def test_masked_server_frame_rejected(self):
        self.server.sendall(b'\x81\x80')
        with self.assertRaises(RuntimeError): self.ws.receive(1)

    def test_close_and_unexpected_continuation(self):
        self.server.sendall(b'\x80\x00')
        with self.assertRaises(RuntimeError): self.ws.receive(1)

    def test_credentials_reject_header_injection(self):
        with self.assertRaises(ValueError): a.AgentWebSocket('https://example.com', 'user\r\nX: injected', 'pass')

class ReportingTests(unittest.TestCase):
    def test_integer_intervals_and_five_second_cadence(self):
        from unittest.mock import patch
        for interval in (1, 2, 5, 10, 59, 60):
            with self.subTest(interval=interval):
                clock = [0.0]
                latest = {'metrics': {'network_in': 1}, 'time': 0}
                sent = []
                class Connection:
                    ack = False
                    def report(self, metrics):
                        sent.append(clock[0]); self.ack = True
                    def send_frame(self, *args): pass
                    def receive(self, timeout):
                        if self.ack:
                            self.ack = False
                            return {'type': 'ack', 'seconds': interval}
                        clock[0] += timeout
                        latest['time'] = clock[0]
                        if clock[0] > interval * 3 + 1: raise KeyboardInterrupt()
                with patch.object(a.time, 'monotonic', lambda: clock[0]):
                    with self.assertRaises(KeyboardInterrupt):
                        a.stream_metrics(Connection(), latest, lambda: None)
                self.assertGreaterEqual(len(sent), 3)
                # The first sample may precede the server's initial hint.
                for before, after in zip(sent[1:], sent[2:]):
                    self.assertAlmostEqual(after - before, interval, delta=.02)

    def test_invalid_server_intervals_are_rejected(self):
        for interval in (0, -1, 61, 1.5, True, '5', None):
            with self.subTest(interval=interval):
                class Connection:
                    def receive(self, timeout): return {'type': 'interval', 'seconds': interval}
                    def send_frame(self, *args): pass
                with self.assertRaisesRegex(RuntimeError, 'Invalid reporting interval'):
                    a.stream_metrics(Connection(), {'metrics': None, 'time': 0}, lambda: None)

    def test_report_frequency_tracks_server_hints(self):
        from unittest.mock import patch
        clock = [0.0]
        latest = {'metrics': {'network_in': 1}, 'time': 0}
        sent, pings = [], []
        controls = [(0, {'type':'interval','seconds':1}), (3.1, {'type':'interval','seconds':60})]
        class Connection:
            ack = False
            def report(self, metrics):
                sent.append(clock[0]); self.ack = True
            def send_frame(self, payload, opcode): pings.append(opcode)
            def receive(self, timeout):
                if controls and controls[0][0] <= clock[0]: return controls.pop(0)[1]
                if self.ack:
                    self.ack=False
                    return {'type':'ack','seconds':1 if clock[0] < 3.1 else 60}
                clock[0] += timeout
                latest['time'] = clock[0]
                if clock[0] >= 66: raise KeyboardInterrupt()
        with patch.object(a.time,'monotonic',lambda:clock[0]):
            with self.assertRaises(KeyboardInterrupt): a.stream_metrics(Connection(),latest,lambda:None)
        self.assertTrue(any(0.9 <= b-a <= 1.1 for a,b in zip(sent,sent[1:])),sent)
        self.assertTrue(any(b-a >= 59 for a,b in zip(sent,sent[1:])),sent)
        self.assertIn(9,pings)

    def test_lost_ack_forces_reconnect(self):
        from unittest.mock import patch
        clock=[0.0]
        class Connection:
            def report(self, metrics): pass
            def send_frame(self,*args): pass
            def receive(self,timeout): clock[0]+=timeout
        with patch.object(a.time,'monotonic',lambda:clock[0]):
            with self.assertRaisesRegex(RuntimeError,'acknowledgement timed out'):
                a.stream_metrics(Connection(),{'metrics':{'network_in':1},'time':0},lambda:None)

    def test_failed_connect_uses_exponential_backoff(self):
        from unittest.mock import patch
        sleeps=[]
        with patch.object(a.threading,'Thread'), patch.object(a,'AgentWebSocket',side_effect=[RuntimeError('failure')]*4+[KeyboardInterrupt()]), patch.object(a.time,'sleep',lambda seconds:sleeps.append(seconds)), patch('random.random',lambda:0):
            with self.assertRaises(KeyboardInterrupt): a.run_agent()
        self.assertEqual(sleeps,[1,2,4,8])
