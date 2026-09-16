#!/usr/bin/env python3
"""
节点可用性实测工具：对订阅里拉到的每个节点做分级握手。

分三级，越往下越能证明「真能用」：
  L1 TCP   —— 端口是否可达
  L2 TLS   —— 带正确 SNI 能否完成握手（1034 / 证书不匹配会在这一级暴露）
  L3 WS    —— WebSocket upgrade 是否拿到 101（edgetunnel 的入口就是 ws）
  L4 VLESS —— 真正发一条 VLESS 请求，看能否把数据代理出去

用法：
  python3 tools/check-nodes.py <订阅文件> [并发数]
"""
import base64
import concurrent.futures as cf
import os
import socket
import ssl
import struct
import sys
import urllib.parse
import uuid as uuid_


def parse_nodes(text):
    """订阅内容可能是明文或 base64，两者都要能吃下。"""
    raw = text.strip()
    if "://" not in raw:
        try:
            raw = base64.b64decode(raw + "=" * (-len(raw) % 4)).decode("utf-8", "replace")
        except Exception:
            return []
    out = []
    for line in raw.splitlines():
        line = line.strip()
        if "://" not in line:
            continue
        scheme, rest = line.split("://", 1)
        if scheme.lower() not in ("vless", "trojan", "ss", "vmess"):
            continue
        if scheme.lower() == "vmess":
            continue  # vmess 是 JSON 结构，另行处理
        frag = ""
        if "#" in rest:
            rest, frag = rest.split("#", 1)
        query = {}
        if "?" in rest:
            rest, qs = rest.split("?", 1)
            query = dict(urllib.parse.parse_qsl(qs))
        # ss:// 的 userinfo 可能是 base64；vless/trojan 是明文 uuid@host:port
        host, port = None, None
        if "@" in rest:
            _, addr = rest.rsplit("@", 1)
        else:
            addr = rest
        if ":" in addr:
            host, _, port = addr.rpartition(":")
        if not host or not port:
            continue
        try:
            port = int(port)
        except ValueError:
            continue
        out.append({
            "scheme": scheme.lower(),
            "host": host,
            "port": port,
            "uuid": rest.rsplit("@", 1)[0] if "@" in rest else "",
            "query": query,
            "name": urllib.parse.unquote(frag),
        })
    return out


# L4 的探测目标。都不托管在 Cloudflare 上（原因见 probe 里的注释），命中任一即算链路通。
PROBE_TARGETS = [
    ("httpbin.org", b"GET /get HTTP/1.1\r\nHost: httpbin.org\r\nConnection: close\r\n\r\n"),
    ("www.baidu.com", b"GET / HTTP/1.1\r\nHost: www.baidu.com\r\nConnection: close\r\n\r\n"),
    ("www.qq.com", b"GET / HTTP/1.1\r\nHost: www.qq.com\r\nConnection: close\r\n\r\n"),
]


def ws_frame(payload: bytes) -> bytes:
    """客户端发的 WebSocket 帧必须 mask。"""
    mask = os.urandom(4)
    n = len(payload)
    head = b"\x82"  # FIN + binary
    if n < 126:
        head += struct.pack("!B", 0x80 | n)
    elif n < 65536:
        head += struct.pack("!BH", 0x80 | 126, n)
    else:
        head += struct.pack("!BQ", 0x80 | 127, n)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return head + mask + masked


def vless_request(uuid: str, target_host: str, target_port: int, payload: bytes = b"") -> bytes:
    """VLESS TCP 请求的 header + 初始 payload。"""
    # UUID 在线上只占 16 字节二进制：直接 encode 36 字符的字符串会让 header 整体错位，
    # 服务端解析失败就不回包 —— 表现为「WS 握手正常但转发没反应」，极具迷惑性。
    try:
        uid = uuid_.UUID(uuid).bytes
    except Exception:
        uid = uuid.encode()[:16].ljust(16, b"\0")
    body = bytes([0x00])                      # version
    body += uid                               # 16 字节 UUID（二进制）
    body += bytes([0x00])                     # addons length
    body += bytes([0x01])                     # cmd: TCP
    body += struct.pack("!H", target_port)
    try:
        packed = socket.inet_aton(target_host)
        body += bytes([0x01]) + packed        # IPv4
    except OSError:
        h = target_host.encode()
        body += bytes([0x02, len(h)]) + h     # domain
    return body + payload


def probe(node, timeout=9):
    host, port = node["host"], node["port"]
    sni = node["query"].get("sni") or node["query"].get("host") or ""
    path = urllib.parse.unquote(node["query"].get("path") or "/")
    result = {"node": node, "level": "FAIL", "detail": ""}

    try:
        sock = socket.create_connection((host, port), timeout=timeout)
    except Exception as e:
        result["detail"] = "TCP: " + str(e)[:60]
        return result
    result["level"] = "L1"
    try:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        tls = ctx.wrap_socket(sock, server_hostname=sni or host)
    except Exception as e:
        result["detail"] = "TLS: " + str(e)[:60]
        try: sock.close()
        except Exception: pass
        return result
    result["level"] = "L2"
    try:
        key = base64.b64encode(os.urandom(16)).decode()
        lines = [
            f"GET {path} HTTP/1.1",
            f"Host: {sni or host}",
            "Upgrade: websocket",
            "Connection: Upgrade",
            f"Sec-WebSocket-Key: {key}",
            "Sec-WebSocket-Version: 13",
            "\r\n",
        ]
        tls.sendall("\r\n".join(lines).encode())
        resp = b""
        tls.settimeout(timeout)
        while b"\r\n\r\n" not in resp and len(resp) < 8192:
            chunk = tls.recv(2048)
            if not chunk:
                break
            resp += chunk
        head = resp.split(b"\r\n\r\n", 1)[0].decode("utf-8", "replace")
        if "101" not in head.split("\r\n", 1)[0]:
            result["detail"] = "WS: " + head.split("\r\n", 1)[0][:60]
            try: tls.close()
            except Exception: pass
            return result
        result["level"] = "L3"
        # L4：真正把一条 HTTP 请求代理出去，验证不只是握手通、转发也通。
        # 目标刻意选择没有托管在 Cloudflare 上的站点：CF 对自己边缘 IP 发来的明文
        # HTTP 请求会直接回 400，那属于目标侧行为，用它当判据会把健康节点误判成坏的。
        res = None
        for tgt, req in PROBE_TARGETS:
            try:
                tls.sendall(ws_frame(vless_request(node["uuid"], tgt, 80, req)))
                buf = b""
                for _ in range(10):
                    chunk = tls.recv(4096)
                    if not chunk:
                        break
                    buf += chunk
                    if len(buf) > 3000:
                        break
                if b"HTTP/" in buf:
                    res = (tgt, buf)
                    break
            except Exception:
                continue
        if res:
            tgt, buf = res
            result["level"] = "L4"
            head = buf.split(b"HTTP/", 1)[1].decode("utf-8", "replace").split("\r\n")[0]
            result["detail"] = f"{tgt} HTTP/{head}"
        else:
            result["detail"] = "WS ok，但 VLESS 转发无回包"
        try: tls.close()
        except Exception: pass
    except Exception as e:
        result["detail"] = str(e)[:60]
    return result


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    text = open(sys.argv[1], "rb").read().decode("utf-8", "replace")
    nodes = parse_nodes(text)
    if not nodes:
        print("未解析出任何节点")
        sys.exit(1)
    workers = int(sys.argv[2]) if len(sys.argv) > 2 else 16
    print(f"解析到 {len(nodes)} 个节点，并发 {workers} 开始实测…\n")

    tally = {}
    rows = []
    with cf.ThreadPoolExecutor(max_workers=workers) as ex:
        futures = [ex.submit(probe, n) for n in nodes]
        for f in cf.as_completed(futures):
            r = f.result()
            tally[r["level"]] = tally.get(r["level"], 0) + 1
            rows.append(r)

    order = {"L4": 0, "L3": 1, "L2": 2, "L1": 3, "FAIL": 4}
    rows.sort(key=lambda r: (order[r["level"]], r["node"]["host"]))
    for r in rows:
        n = r["node"]
        print(f"  [{r['level']:<4}] {n['host']}:{n['port']}  {n['name'][:38]:<38} {r['detail']}")

    print(f"\n合计 {len(rows)} 个：")
    for k in ("L4", "L3", "L2", "L1", "FAIL"):
        if tally.get(k):
            print(f"  {k}: {tally[k]}")
    bad = tally.get("FAIL", 0) + tally.get("L1", 0) + tally.get("L2", 0)
    print(f"\n不可直接使用（TCP/TLS 就不通）: {bad}")


if __name__ == "__main__":
    main()
