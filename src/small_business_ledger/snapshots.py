"""Bounded, atomic JSON snapshots read from the caller's SQLite transaction."""

import json
import os
import re
import tempfile
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

MANAGED_NAME = re.compile(r"ledger-auto-[0-9]{8}T[0-9]{12}Z-[0-9a-f]{32}\.json\Z")
RETENTION = 30
MAX_BYTES = 128 * 1024 * 1024


class SnapshotError(ValueError):
    pass


class Snapshots:
    def __init__(self, database_path):
        path = Path(database_path).resolve()
        self.directory = path.with_name(path.name + ".backups")
        self._validated = {}

    def _check_directory(self, create=False):
        if self.directory.is_symlink() or self.directory.is_junction():
            raise SnapshotError("备份目录不能是符号链接或目录联接")
        if create:
            self.directory.mkdir(parents=True, exist_ok=True)
        if self.directory.exists() and not self.directory.is_dir():
            raise SnapshotError("备份路径不是文件夹")

    def _files(self):
        self._check_directory()
        if not self.directory.exists():
            return []
        candidates = [
            p
            for p in self.directory.iterdir()
            if MANAGED_NAME.fullmatch(p.name) and not p.is_symlink() and p.is_file()
        ]
        # Unknown formats and corrupt files are never silently removed. Cache
        # validation by filesystem identity so each daily write need not parse
        # thirty complete ledgers; edits/replacements force revalidation.
        files = []
        for path in candidates:
            try:
                if self._recognized(path):
                    files.append(path)
            except FileNotFoundError:
                # A concurrent writer may have just rotated this snapshot away.
                continue
        names = {p.name for p in candidates}
        self._validated = {k: v for k, v in list(self._validated.items()) if k in names}
        return sorted(files, key=lambda p: p.name, reverse=True)

    @staticmethod
    def _signature(path):
        info = path.stat()
        return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)

    def _recognized(self, path):
        from .transfer import _validate_backup

        signature = self._signature(path)
        cached = self._validated.get(path.name)
        if cached and cached[0] == signature:
            return cached[1]
        valid = False
        try:
            self._info(path)  # A matching filename may still have an invalid date.
            if signature[2] <= MAX_BYTES:
                _validate_backup(json.loads(path.read_text(encoding="utf-8")))
                valid = True
        except (ValueError, UnicodeError):
            pass
        self._validated[path.name] = (signature, valid)
        return valid

    @staticmethod
    def _info(path):
        stamp = path.name.removeprefix("ledger-auto-").split("Z-", 1)[0]
        created = datetime.strptime(stamp, "%Y%m%dT%H%M%S%f").replace(tzinfo=UTC)
        return {
            "filename": path.name,
            "created_at": created.isoformat(),
            "size_bytes": path.stat().st_size,
        }

    def list(self):
        items = []
        for path in self._files():
            try:
                items.append(self._info(path))
            except FileNotFoundError:
                continue
        return {
            "directory": str(self.directory),
            "retention": RETENTION,
            "items": items,
        }

    def create(self, conn):
        # JSON reading on this same transaction is consistent, including WAL data.
        # Do not call SQLite's backup() using a connection holding a write lock.
        from .transfer import _validate_backup, make_backup_from_connection

        backup = make_backup_from_connection(conn)
        _validate_backup(backup)
        data = json.dumps(backup, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(data) > MAX_BYTES:
            raise SnapshotError("完整备份超过 128 MiB 上限")
        self._check_directory(create=True)
        name = f"ledger-auto-{datetime.now(UTC):%Y%m%dT%H%M%S%f}Z-{uuid4().hex}.json"
        destination = self.directory / name
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(
                dir=self.directory, prefix=".pending-", suffix=".tmp", delete=False
            ) as output:
                temporary = Path(output.name)
                output.write(data)
                output.flush()
                os.fsync(output.fileno())
            # Validate bytes actually written before publishing the file.
            _validate_backup(json.loads(temporary.read_text(encoding="utf-8")))
            os.replace(temporary, destination)
            temporary = None
            self._validated[name] = (self._signature(destination), True)
            for old in self._files()[RETENTION:]:
                old.unlink()
            return self._info(destination)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)

    def read(self, filename):
        from .transfer import _validate_backup

        self._check_directory()
        if not MANAGED_NAME.fullmatch(filename):
            raise FileNotFoundError(filename)
        path = self.directory / filename
        if path.is_symlink() or not path.is_file():
            raise FileNotFoundError(filename)
        if path.stat().st_size > MAX_BYTES:
            raise SnapshotError("备份文件过大")
        data = json.loads(path.read_text(encoding="utf-8"))
        _validate_backup(data)
        return data
