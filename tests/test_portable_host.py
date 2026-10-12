"""Exercise the real loopback socket, not a mocked HTTP transport."""

import http.client
import json
import socket
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "distribution"))


class Echo:
    def handle(self, method, path, query, body, headers):
        return (
            200,
            {"Content-Type": "application/json"},
            json.dumps({"path": path, "body": body}).encode(),
        )


@pytest.fixture
def host(tmp_path):
    from portable_host import make_server

    (tmp_path / "web").mkdir()
    (tmp_path / "web" / "index.html").write_text("<h1>local app</h1>", encoding="utf-8")
    (tmp_path / "private.json").write_text("secret", encoding="utf-8")
    server = make_server(Echo(), tmp_path)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()
    thread.join(timeout=5)


def request(server, path="/", method="GET", body=None, headers=None, authenticated=True):
    connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=3)
    supplied = {"Cookie": server.cookie.split(";", 1)[0]} if authenticated else {}
    supplied.update(headers or {})
    connection.request(method, path, body=body, headers=supplied)
    response = connection.getresponse()
    result = response.status, dict(response.getheaders()), response.read()
    connection.close()
    return result


def test_requires_current_cookie_for_every_resource(host):
    assert request(host, authenticated=False)[0] == 401
    assert request(host, "/__health", authenticated=False)[0] == 401
    assert request(host, headers={"Cookie": "old=token"})[0] == 401
    status, headers, content = request(host)
    assert status == 200 and b"local app" in content
    assert headers["Cache-Control"] == "no-store"
    assert headers["X-Content-Type-Options"] == "nosniff"
    assert "HttpOnly" in host.cookie and "SameSite=Strict" in host.cookie


@pytest.mark.parametrize(
    "headers",
    [
        {"Host": "attacker.example"},
        {"Origin": "https://evil.example"},
        {"Origin": "null"},
        {"Sec-Fetch-Site": "cross-site"},
        {"Sec-Fetch-Site": "same-site"},
    ],
)
def test_rejects_other_origins(host, headers):
    assert request(host, headers=headers)[0] == 403


@pytest.mark.parametrize(
    "path",
    [
        "/../private.json",
        "/%2e%2e/private.json",
        "/%252e%252e/private.json",
        "/assets\\..\\private.json",
        "/missing.js",
    ],
)
def test_static_paths_do_not_escape_bundle(host, path):
    assert request(host, path)[0] == 404


def test_json_contract_and_bounds(host):
    assert request(host, "/api/test", "POST", "{}", {"Content-Type": "text/plain"})[0] == 415
    assert request(host, "/api/test", "POST", "[]", {"Content-Type": "application/json"})[0] == 422
    assert (
        request(host, "/api/test", "POST", '{"x":NaN}', {"Content-Type": "application/json"})[0]
        == 422
    )
    assert (
        request(host, "/api/test", "POST", '{"x":1,"x":2}', {"Content-Type": "application/json"})[0]
        == 422
    )
    status, _, content = request(
        host,
        "/api/test",
        "POST",
        '{"x":1}',
        {"Content-Type": "application/json", "Origin": host.origin},
    )
    assert status == 200 and json.loads(content)["body"] == {"x": 1}
    assert (
        request(
            host,
            "/api/test",
            "POST",
            b"",
            {"Content-Length": str(32 * 1024 * 1024 + 1), "Content-Type": "application/json"},
        )[0]
        == 413
    )


@pytest.mark.parametrize(
    "extra",
    [
        "Host: attacker.example\r\n",
        "Content-Length: 0\r\nContent-Length: 1\r\n",
        "Transfer-Encoding: chunked\r\n",
        "Origin: null\r\nOrigin: null\r\n",
    ],
)
def test_ambiguous_http_framing_is_rejected_before_body(host, extra):
    raw = f"POST /api/x HTTP/1.1\r\nHost: 127.0.0.1:{host.server_port}\r\nCookie: {host.cookie.split(';')[0]}\r\nContent-Type: application/json\r\n{extra}\r\n"
    with socket.create_connection(("127.0.0.1", host.server_port), timeout=3) as connection:
        connection.sendall(raw.encode())
        assert connection.recv(4096).split(b" ")[1] == b"400"
