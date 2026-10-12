"""Copy an explicit allowlist. Never bundle a developer's real account data."""

import argparse
import json
import shutil
import subprocess
from pathlib import Path

try:
    from .resource_staging import reset_resources
except ImportError:
    from resource_staging import reset_resources

ROOT = Path(__file__).resolve().parents[1]


def prepare_resources(project_root: Path, resource_dir: Path):
    resource_dir = reset_resources(project_root, resource_dir)
    frontend = project_root / "frontend" / "dist"
    if not (frontend / "index.html").is_file():
        raise RuntimeError("Build frontend first: npm ci && npm run build")
    shutil.copytree(frontend, resource_dir / "web", dirs_exist_ok=True)
    shutil.copy2(project_root / "distribution" / "app.json", resource_dir / "app.json")
    (resource_dir / "licenses").mkdir(exist_ok=True)
    shutil.copy2(project_root / "LICENSE", resource_dir / "licenses" / "LICENSE")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--python-dir", type=Path, default=ROOT / "android/app/build/generated/python"
    )
    parser.add_argument(
        "--assets-dir", type=Path, default=ROOT / "android/app/build/generated/assets/application"
    )
    args = parser.parse_args()
    prepare_resources(ROOT, args.assets_dir)
    config_path = args.assets_dir / "app.json"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["build_revision"] = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], cwd=ROOT, text=True
    ).strip()
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    index = args.assets_dir / "web/index.html"
    index.write_text(
        index.read_text(encoding="utf-8").replace(
            "</head>", '<meta name="ledger-runtime" content="mobile"></head>', 1
        ),
        encoding="utf-8",
    )
    args.python_dir = reset_resources(ROOT, args.python_dir)
    for filename in ["portable_host.py", "mobile_app.py"]:
        shutil.copy2(ROOT / "distribution" / filename, args.python_dir / filename)
    core = args.python_dir / "small_business_ledger"
    core.mkdir(exist_ok=True)
    for filename in [
        "__init__.py",
        "models.py",
        "store.py",
        "reports.py",
        "migrations.py",
        "snapshots.py",
        "transfer.py",
    ]:
        shutil.copy2(ROOT / "src/small_business_ledger" / filename, core / filename)
    print(json.dumps({"python": str(args.python_dir), "resources": str(args.assets_dir)}))


if __name__ == "__main__":
    main()
