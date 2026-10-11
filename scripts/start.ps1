# Keep this launcher ASCII-compatible with Windows PowerShell 5.1.
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
if (-not (Get-Command uv -ErrorAction SilentlyContinue)) { throw 'Install uv first: https://docs.astral.sh/uv/getting-started/installation/' }
if (-not (Test-Path 'frontend/dist/index.html')) { throw 'Build the UI first: cd frontend; npm ci; npm run build' }
uv sync --frozen --no-dev
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
Write-Host 'Small Business Ledger: http://127.0.0.1:8000 (Ctrl+C to stop)'
uv run --no-sync uvicorn small_business_ledger.app:create_app --factory --host 127.0.0.1 --port 8000
