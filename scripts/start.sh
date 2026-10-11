#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
test -f frontend/dist/index.html || { echo '请先 cd frontend && npm ci && npm run build'; exit 1; }
uv sync --frozen --no-dev
exec uv run --no-sync uvicorn small_business_ledger.app:create_app --factory --host 127.0.0.1 --port 8000
