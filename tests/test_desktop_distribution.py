import json
import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def test_desktop_session_bootstrap_is_single_use_and_locks_api():
    from distribution.desktop_launcher import DesktopSession

    app = FastAPI()

    @app.get("/private")
    def private():
        return {"private": True}

    stopped = []
    secured = DesktopSession(
        app, "http://127.0.0.1:43210", "测试应用", lambda: stopped.append(True)
    )
    with TestClient(secured, base_url=secured.origin) as client:
        assert client.get("/private").status_code == 401
        assert (
            client.get(secured.launch_path, headers={"Origin": "https://evil.test"}).status_code
            == 403
        )
        launch = client.get(secured.launch_path, follow_redirects=False)
        assert launch.status_code == 303
        assert "HttpOnly" in launch.headers["set-cookie"]
        assert client.get(secured.launch_path, follow_redirects=False).status_code == 404
        assert client.get("/private").json() == {"private": True}
        assert client.get("/private", headers={"Host": "evil.test"}).status_code == 403
        assert client.get("/__desktop").status_code == 200
        assert client.post("/__stop", json={}).status_code == 403
        assert (
            client.post("/__stop", json={}, headers={"X-Desktop-Request": "1"}).status_code == 200
        )
        assert stopped == [True]


def test_distribution_resource_manifest_copies_no_private_ledger(tmp_path):
    from distribution.prepare_android import prepare_resources

    root = tmp_path / "source"
    (root / "frontend/dist").mkdir(parents=True)
    (root / "frontend/dist/index.html").write_text("<h1>UI</h1>", encoding="utf-8")
    (root / "distribution").mkdir()
    (root / "distribution/app.json").write_text('{"version":"0.3.0"}', encoding="utf-8")
    (root / "LICENSE").write_text("MIT", encoding="utf-8")
    prepare_resources(root, tmp_path / "resources")
    config = json.loads((tmp_path / "resources" / "app.json").read_text(encoding="utf-8"))
    assert config["version"] == "0.3.0"
    assert (tmp_path / "resources" / "web" / "index.html").is_file()
    assert (tmp_path / "resources" / "licenses" / "LICENSE").is_file()
    assert not list((tmp_path / "resources").rglob("*.db"))
    (tmp_path / "resources" / "obsolete.db").write_bytes(b"not a real ledger")
    prepare_resources(root, tmp_path / "resources")
    assert not (tmp_path / "resources" / "obsolete.db").exists()


def test_resource_generation_refuses_an_unowned_nonempty_directory(tmp_path):
    import pytest

    from distribution.resource_staging import reset_resources

    output = tmp_path / "user files"
    output.mkdir()
    original = output / "notes.txt"
    original.write_text("keep me", encoding="utf-8")
    with pytest.raises(ValueError, match="unmarked"):
        reset_resources(Path(__file__).resolve().parents[1], output)
    assert original.read_text(encoding="utf-8") == "keep me"


def test_bundled_desktop_uses_explicit_data_and_resource_paths(tmp_path, monkeypatch):
    from distribution.desktop_app import create_app

    resources = tmp_path / "read only 安装目录"
    (resources / "web").mkdir(parents=True)
    (resources / "web" / "index.html").write_text("bundled page", encoding="utf-8")
    unrelated = tmp_path / "cwd"
    unrelated.mkdir()
    monkeypatch.chdir(unrelated)
    with TestClient(
        create_app(str(tmp_path / "user data"), str(resources)), base_url="http://localhost"
    ) as client:
        assert client.get("/").text == "bundled page"
        assert client.get("/api/meta").status_code == 200
    assert (tmp_path / "user data" / "ledger.db").is_file()
    assert not list(resources.rglob("*.db"))
    assert not list(unrelated.rglob("*.db"))
