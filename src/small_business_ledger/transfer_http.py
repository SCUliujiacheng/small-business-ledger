"""FastAPI routes, kept out of the dependency-free transfer implementation."""

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response

from .transfer import (
    _payload,
    commit_csv,
    export_entries,
    export_outstanding,
    export_payments,
    export_template,
    make_backup,
    preview_csv,
    restore_backup,
)

router = APIRouter(prefix="/api")


def _download(content, filename):
    return Response(
        content,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/export/entries.csv")
def entries_download(request: Request):
    return _download(export_entries(request.app.state.store), "ledger-entries.csv")


@router.get("/export/payments.csv")
def payments_download(request: Request):
    return _download(export_payments(request.app.state.store), "ledger-payments.csv")


@router.get("/export/outstanding.csv")
def outstanding_download(request: Request, as_of: str):
    return _download(export_outstanding(request.app.state.store, as_of), "ledger-outstanding.csv")


@router.get("/import/template.csv")
def template_download():
    return _download(export_template(), "ledger-template.csv")


@router.post("/import/preview")
def preview_endpoint(request: Request, payload: dict):
    return preview_csv(request.app.state.store, _payload(payload, "csv_text"))


@router.post("/import/commit")
def commit_endpoint(request: Request, payload: dict):
    return commit_csv(request.app.state.store, _payload(payload, "csv_text"))


@router.get("/backup")
def backup_endpoint(request: Request):
    return JSONResponse(
        make_backup(request.app.state.store),
        headers={"Content-Disposition": 'attachment; filename="ledger-backup.json"'},
    )


@router.post("/restore")
def restore_endpoint(request: Request, payload: dict):
    return restore_backup(request.app.state.store, _payload(payload, "backup"))
