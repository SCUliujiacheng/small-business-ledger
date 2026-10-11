"""Same-origin HTTP API and production frontend for the local ledger."""

import os
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse

from .store import LedgerError, Store

BODY_LIMIT = 10 * 1024 * 1024
# Max 10,000 records can exceed 10 MiB with valid Chinese notes. Reserve enough
# for every exported ledger (including JSON-escaped control characters).
RESTORE_BODY_LIMIT = 128 * 1024 * 1024
LOOPBACK_NAMES = {"127.0.0.1", "localhost", "::1"}
SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
}


def _origin(value):
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme not in {"http", "https"}
            or parsed.hostname not in LOOPBACK_NAMES
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path
            or parsed.query
            or parsed.fragment
        ):
            return None
        return (
            parsed.scheme,
            parsed.hostname,
            parsed.port or (443 if parsed.scheme == "https" else 80),
        )
    except ValueError:
        return None


class LocalOnlyMiddleware:
    def __init__(self, app, development=False):
        self.app = app
        self.development = development

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {}
        for key, value in scope["headers"]:
            name = key.decode("latin-1").lower()
            if name in headers and name in {"host", "origin", "content-length"}:
                await self._error(scope, receive, send, "请求头重复", 400)
                return
            headers[name] = value.decode("latin-1")
        request_origin = _origin(f"{scope.get('scheme', 'http')}://{headers.get('host', '')}")
        if request_origin is None:
            await self._error(scope, receive, send, "仅允许通过 localhost 或回环地址访问", 403)
            return
        origin = headers.get("origin")
        allowed = {request_origin}
        if self.development:
            allowed.update({("http", "127.0.0.1", 5173), ("http", "localhost", 5173)})
        if origin is not None and _origin(origin) not in allowed:
            await self._error(scope, receive, send, "只允许同源请求", 403)
            return
        fetch_site = headers.get("sec-fetch-site", "")
        if fetch_site == "cross-site" or (fetch_site == "same-site" and origin is None):
            await self._error(scope, receive, send, "不接受跨站请求", 403)
            return
        if scope["method"] not in {"GET", "HEAD", "OPTIONS"}:
            if headers.get("x-ledger-request") != "1":
                await self._error(scope, receive, send, "写操作需要 X-Ledger-Request 请求头", 403)
                return
            if (
                headers.get("content-type", "").split(";", 1)[0].strip().lower()
                != "application/json"
            ):
                await self._error(scope, receive, send, "写操作须使用 application/json", 415)
                return
        try:
            length = int(headers.get("content-length", "0"))
            if length < 0:
                raise ValueError
        except ValueError:
            await self._error(scope, receive, send, "Content-Length 不合法", 400)
            return
        limit = RESTORE_BODY_LIMIT if scope["path"] == "/api/restore" else BODY_LIMIT
        if length > limit:
            await self._error(
                scope, receive, send, f"请求内容超过 {limit // (1024 * 1024)} MiB 上限", 413
            )
            return
        chunks, total = [], 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            total += len(chunk)
            if total > limit:
                await self._error(
                    scope, receive, send, f"请求内容超过 {limit // (1024 * 1024)} MiB 上限", 413
                )
                return
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        body = b"".join(chunks)
        delivered = False

        async def replay():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        async def secure_send(message):
            if message["type"] == "http.response.start":
                extra = SECURITY_HEADERS | (
                    {"Cache-Control": "no-store"} if scope["path"].startswith("/api") else {}
                )
                message["headers"] = list(message.get("headers", [])) + [
                    (name.lower().encode(), value.encode()) for name, value in extra.items()
                ]
            await send(message)

        await self.app(scope, replay, secure_send)

    @staticmethod
    async def _error(scope, receive, send, detail, status):
        response = JSONResponse({"detail": detail}, status_code=status, headers=SECURITY_HEADERS)
        await response(scope, receive, send)


def create_app(db_path=None):
    app = FastAPI(title="小本账", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.store = Store(db_path or os.environ.get("LEDGER_DB_PATH", "data/ledger.db"))
    app.add_middleware(LocalOnlyMiddleware, development=os.environ.get("LEDGER_DEV") == "1")

    @app.exception_handler(LedgerError)
    async def ledger_error_handler(request: Request, exc: LedgerError):
        return JSONResponse({"detail": exc.detail}, status_code=exc.status_code)

    @app.exception_handler(RequestValidationError)
    async def request_validation_handler(request: Request, exc: RequestValidationError):
        # Do not echo untrusted input: it may contain invalid Unicode or private notes.
        return JSONResponse({"detail": "请求格式不正确，请检查字段类型和必填项"}, status_code=422)

    @app.get("/api/meta")
    def get_meta():
        return app.state.store.meta()

    @app.get("/api/entries")
    def get_entries():
        return {"items": app.state.store.entries()}

    @app.post("/api/entries", status_code=201)
    def post_entry(request: Request, payload: dict):
        return app.state.store.create_entry(payload, request.headers.get("idempotency-key"))

    @app.post("/api/entries/{entry_id}/void")
    def void_entry(entry_id: str, payload: dict):
        if set(payload) != {"reason"}:
            raise LedgerError("作废请求只接受 reason 字段")
        return app.state.store.void_entry(entry_id, payload["reason"])

    @app.get("/api/payments")
    def get_payments():
        return {"items": app.state.store.payments()}

    @app.post("/api/payments", status_code=201)
    def post_payment(request: Request, payload: dict):
        return app.state.store.create_payment(payload, request.headers.get("idempotency-key"))

    @app.post("/api/payments/{payment_id}/void")
    def void_payment(payment_id: str, payload: dict):
        if set(payload) != {"reason"}:
            raise LedgerError("作废请求只接受 reason 字段")
        return app.state.store.void_payment(payment_id, payload["reason"])

    @app.get("/api/summary")
    def get_summary(start: str, end: str):
        return app.state.store.summary(start, end)

    @app.get("/api/outstanding")
    def get_outstanding(as_of: str):
        return app.state.store.outstanding(as_of)

    @app.get("/api/local-backups")
    def get_local_backups():
        return app.state.store.local_backups()

    @app.post("/api/local-backups", status_code=201)
    def create_local_backup(payload: dict):
        if payload:
            raise LedgerError("备份请求须为空对象")
        return app.state.store.snapshot_now()

    @app.get("/api/local-backups/{filename}")
    def download_local_backup(filename: str):
        return JSONResponse(
            app.state.store.read_snapshot(filename),
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    @app.post("/api/demo")
    def demo(payload: dict):
        if payload:
            raise LedgerError("示例请求须为空对象")
        return app.state.store.seed_demo()

    from .transfer import router

    app.include_router(router)

    dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"

    @app.get("/{requested_path:path}")
    def frontend(requested_path: str):
        if requested_path == "api" or requested_path.startswith("api/"):
            return JSONResponse({"detail": "接口不存在"}, status_code=404)
        candidate = (dist / requested_path).resolve()
        if not candidate.is_relative_to(dist.resolve()):
            return JSONResponse({"detail": "路径不合法"}, status_code=404)
        if candidate.is_file():
            return FileResponse(candidate)
        if requested_path and (Path(requested_path).suffix or requested_path.startswith("assets/")):
            return JSONResponse({"detail": "资源不存在"}, status_code=404)
        index = dist / "index.html"
        if index.is_file():
            return FileResponse(index)
        return HTMLResponse(
            "<h1>小本账</h1><p>前端尚未构建。请在 frontend 目录运行 npm ci 和 npm run build。</p>",
            status_code=503,
        )

    return app
