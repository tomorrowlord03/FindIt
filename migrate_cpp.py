"""Migrate a standalone C++ FindIt SQLite backup to the Python schema.

Status mapping: Open and Possible Match become Open. Claimed and Returned
become Returned, the Python server's closed report status. This keeps reports
claimed in C++ from accepting new claims and creates no handover records.
"""

import argparse
import os
import sqlite3
import sys
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path

if __name__ == "__main__":
    sys.dont_write_bytecode = True

from server import REPORT_FIELDS, SCHEMA, fingerprint


STATUSES = {"Open": "Open", "Possible Match": "Open", "Claimed": "Returned", "Returned": "Returned"}
FIELDS = [name for name, _, _ in REPORT_FIELDS]


class MigrationError(Exception):
    pass


def converted_rows(source):
    for row in source.execute("SELECT * FROM reports ORDER BY id"):
        try:
            status = STATUSES[row["status"]]
            created = datetime.strptime(row["createdAt"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
        except (KeyError, TypeError, ValueError):
            raise MigrationError("A source report has an invalid status or creation timestamp.") from None
        identifier = f'legacy-{row["id"]}'
        values = {field: (row[field] or "") if field != "privateClue" else "" for field in FIELDS}
        yield (identifier, identifier, fingerprint(values), int(created.timestamp()), status, *values.values())


def copy_reports(source, target):
    expected = source.execute("SELECT COUNT(*) FROM reports").fetchone()[0]
    columns = ",".join(FIELDS)
    marks = ",".join("?" for _ in range(5 + len(FIELDS)))
    with target:
        target.executescript("BEGIN IMMEDIATE;\n" + SCHEMA)
        target.executemany(f"INSERT INTO reports(id,requestId,fingerprint,created,status,{columns}) VALUES ({marks})",
                           converted_rows(source))
        copied = target.execute("SELECT COUNT(*) FROM reports").fetchone()[0]
        if copied != expected:
            raise MigrationError("Source and target report counts differ.")
    return expected, copied


def migrate(source_path, target_path, dry_run):
    if os.path.lexists(target_path):
        raise MigrationError("Target already exists. Choose a new path.")
    source_path = source_path.resolve(strict=True)
    # Immutable mode prevents WAL or shared-memory writes. Only a standalone
    # snapshot can be read this way without missing uncheckpointed changes.
    if any(Path(str(source_path) + suffix).exists() for suffix in ("-wal", "-journal")):
        raise MigrationError("Source has SQLite sidecars. Take a standalone SQLite backup first.")
    with closing(sqlite3.connect(source_path.as_uri() + "?mode=ro&immutable=1", uri=True)) as source:
        source.row_factory = sqlite3.Row
        if dry_run:
            with closing(sqlite3.connect(":memory:")) as target:
                return copy_reports(source, target)

        try:
            fd = os.open(target_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            raise MigrationError("Target already exists. Choose a new path.") from None
        try:
            os.close(fd)
            with closing(sqlite3.connect(target_path)) as target:
                return copy_reports(source, target)
        except (Exception, KeyboardInterrupt):
            target_path.unlink()
            raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--target", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    try:
        source, target = migrate(args.source, args.target, args.dry_run)
    except MigrationError as error:
        parser.exit(1, f"{error}\n")
    except (OSError, sqlite3.Error, IndexError):
        parser.exit(1, "Migration failed. Check the source schema and file permissions.\n")
    print(f"{'Dry run' if args.dry_run else 'Migration'}: {source} source reports, {target} verified target reports.")


if __name__ == "__main__":
    main()
