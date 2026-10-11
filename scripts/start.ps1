$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw '请先安装 uv：https://docs.astral.sh/uv/getting-started/installation/' }
if (-not (Test-Path 'frontend/dist/index.html')) { throw '请先在 frontend 目录运行 npm ci 和 npm run build。' }
uv sync --frozen --no-dev
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败。' }
Write-Host '小本账：http://127.0.0.1:8000（Ctrl+C 退出）'
uv run --no-sync uvicorn small_business_ledger.app:create_app --factory --host 127.0.0.1 --port 8000
