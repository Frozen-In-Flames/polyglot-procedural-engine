#!/usr/bin/env python3
"""Capture the 6 workshop phases over CDP with a hand-rolled stdlib-only
WebSocket client (RFC 6455). TEXT frames only: this Chromium build drops
binary WS frames.

Usage: python3 capture.py
Writes games/workshop/shots/01-pristine.png .. 06-convergence.png (1280x720).
"""
import base64
import hashlib
import json
import os
import random
import socket
import struct
import subprocess
import sys
import time
import urllib.parse
import urllib.request

CHROME = "/opt/meta-chromium/chrome"
PORT = 9222
DIST = "/home/hatch/workspace/xr-engine/games/workshop/dist/index.html"
SHOTS = "/home/hatch/workspace/xr-engine/games/workshop/shots"
NAMES = ["01-pristine", "02-brush", "03-seed", "04-rhythm", "05-behavior", "06-convergence"]
SETTLE_S = 2.5


class WsError(Exception):
    pass


class WsClient:
    """Minimal RFC 6455 client: TEXT frames out (masked), any frames in."""

    def __init__(self, url):
        p = urllib.parse.urlparse(url)
        self.sock = socket.create_connection((p.hostname, p.port or 80), timeout=30)
        key = base64.b64encode(os.urandom(16)).decode()
        req = (
            f"GET {p.path or '/'} HTTP/1.1\r\n"
            f"Host: {p.hostname}:{p.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise WsError("handshake: connection closed")
            head += chunk
        status = head.split(b"\r\n", 1)[0]
        if b"101" not in status:
            raise WsError(f"handshake failed: {status!r}")
        accept = hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode()).digest()
        if base64.b64encode(accept).decode() not in head.decode(errors="replace"):
            raise WsError("handshake: bad accept key")
        self.buf = b""
        self.sock.settimeout(60)

    def _recv_exact(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise WsError("connection closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def send_text(self, text):
        data = text.encode()
        mask = os.urandom(4)
        n = len(data)
        hdr = bytearray([0x81])  # FIN + text
        if n < 126:
            hdr.append(0x80 | n)
        elif n < 65536:
            hdr.append(0x80 | 126)
            hdr += struct.pack(">H", n)
        else:
            hdr.append(0x80 | 127)
            hdr += struct.pack(">Q", n)
        hdr += mask
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        self.sock.sendall(bytes(hdr) + masked)

    def _send_pong(self, payload):
        self.sock.sendall(bytes([0x8A, len(payload)]) + payload)

    def recv_message(self):
        """Return the next complete TEXT message payload (str)."""
        msg = b""
        while True:
            h = self._recv_exact(2)
            b1, b2 = h[0], h[1]
            fin = b1 & 0x80
            op = b1 & 0x0F
            masked = b2 & 0x80
            ln = b2 & 0x7F
            if ln == 126:
                ln = struct.unpack(">H", self._recv_exact(2))[0]
            elif ln == 127:
                ln = struct.unpack(">Q", self._recv_exact(8))[0]
            if masked:
                mask = self._recv_exact(4)
            payload = self._recv_exact(ln)
            if masked:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if op == 0x8:
                raise WsError("server closed")
            if op == 0x9:
                self._send_pong(payload)
                continue
            if op == 0xA:
                continue
            if op == 0x1 or op == 0x0:
                msg += payload
                if fin:
                    return msg.decode()
            # other opcodes ignored

    def close(self):
        try:
            self.sock.sendall(b"\x88\x00")
        except OSError:
            pass
        self.sock.close()


class Cdp:
    def __init__(self, ws_url):
        self.ws = WsClient(ws_url)
        self.next_id = 0

    def call(self, method, params=None, timeout_s=60):
        self.next_id += 1
        mid = self.next_id
        msg = {"id": mid, "method": method}
        if params:
            msg["params"] = params
        self.ws.send_text(json.dumps(msg))
        deadline = time.time() + timeout_s
        while True:
            if time.time() > deadline:
                raise WsError(f"timeout waiting for {method}")
            raw = self.ws.recv_message()
            data = json.loads(raw)
            if data.get("id") == mid:
                if "error" in data:
                    raise WsError(f"CDP error {method}: {data['error']}")
                return data.get("result", {})
            # events (Page.loadEventFired etc.) are ignored here

    def evaluate(self, expr):
        r = self.call("Runtime.evaluate", {"expression": expr, "returnByValue": True})
        res = r.get("result", {})
        if res.get("subtype") == "error" or res.get("type") == "undefined":
            return None
        return res.get("value")

    def close(self):
        self.ws.close()


def wait_http(url, timeout_s=30):
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=5) as r:
                return json.loads(r.read().decode())
        except Exception:
            time.sleep(0.3)
    raise WsError(f"no response from {url}")


def main():
    os.makedirs(SHOTS, exist_ok=True)
    profile = "/tmp/ws-chrome-profile"
    os.makedirs(profile, exist_ok=True)
    proc = subprocess.Popen([
        CHROME,
        "--headless=new",
        f"--remote-debugging-port={PORT}",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--allow-file-access-from-files",
        "--window-size=1280,720",
        f"--user-data-dir={profile}",
        "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        targets = wait_http(f"http://127.0.0.1:{PORT}/json/list")
        page = next(t for t in targets if t.get("type") == "page")
        cdp = Cdp(page["webSocketDebuggerUrl"])
        try:
            cdp.call("Page.enable")
            cdp.call("Runtime.enable")
            cdp.call("Emulation.setDeviceMetricsOverride",
                     {"width": 1280, "height": 720, "deviceScaleFactor": 1, "mobile": False})
            file_url = "file://" + DIST
            cdp.call("Page.navigate", {"url": file_url})
            # wait for the page to signal readiness
            ready = False
            for _ in range(200):
                v = cdp.evaluate("window.__wsReady === true")
                if v:
                    ready = True
                    break
                time.sleep(0.25)
            if not ready:
                raise WsError("page never became ready")
            print("page ready", flush=True)
            for n, name in enumerate(NAMES, start=1):
                cdp.evaluate(f"window.__wsPhase({n})")
                # Deterministic settle: re-derive the ember field as a pure
                # function of (seed, applied ops, n), then photograph it.
                # No wall-clock wait: the state is identical every run.
                cdp.evaluate(f"window.__wsSettle({n})")
                shot = cdp.call("Page.captureScreenshot", {"format": "png"})
                png = base64.b64decode(shot["data"])
                path = os.path.join(SHOTS, name + ".png")
                with open(path, "wb") as f:
                    f.write(png)
                errs = cdp.evaluate("window.__wsErrors.length") or 0
                print(f"{name}.png  {len(png)} bytes  __wsErrors={errs}", flush=True)
            final_errs = cdp.evaluate("window.__wsErrors")
            print("final __wsErrors:", json.dumps(final_errs), flush=True)
        finally:
            cdp.close()
    finally:
        proc.terminate()
        proc.wait(timeout=15)


if __name__ == "__main__":
    sys.exit(main())
