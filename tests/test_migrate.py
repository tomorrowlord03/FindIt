"""Verify migration with the production C++ schema and disposable reports."""

import hashlib
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path

from server import fingerprint
from test_journey import Client, ROOT
from test_password import login, running_server


CPP_SCHEMA = """
CREATE TABLE IF NOT EXISTS reports (
 id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL,
 color TEXT, location TEXT, date TEXT, time TEXT, contact TEXT, contactDetail TEXT, description TEXT,
 status TEXT NOT NULL DEFAULT 'Open', createdAt TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expiresAt INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, val TEXT);
CREATE INDEX IF NOT EXISTS reports_createdAt ON reports(createdAt);
"""


class CppMigration(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        folder = Path(temp.name)
        self.source = folder / "C++ snapshot #1.db"
        self.target = folder / "reports.sqlite3"
        self.recent = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(days=1)
        old = self.recent - timedelta(days=8)
        with closing(sqlite3.connect(self.source)) as db, db:
            db.executescript(CPP_SCHEMA)
            db.executemany(
                """INSERT INTO reports(type,title,category,location,contact,contactDetail,status,createdAt)
                   VALUES ('found','Test notebook','Stationery','Library',?,?,?,?)""",
                [("Test Reporter", "reporter@example.invalid", status, timestamp.strftime("%Y-%m-%d %H:%M:%S"))
                 for status, timestamp in [("Open", self.recent), ("Possible Match", self.recent),
                                           ("Claimed", self.recent), ("Returned", self.recent), ("Open", old)]],
            )
            db.execute("INSERT INTO sessions VALUES ('test-session', 9999999999)")
            db.execute("INSERT INTO settings VALUES ('coordinator_password', 'test-cleartext')")
        self.original_hash = self.source_hash()

    def source_hash(self):
        return hashlib.sha256(self.source.read_bytes()).hexdigest()

    def migrate(self, *flags):
        return subprocess.run(
            [sys.executable, str(ROOT / "migrate_cpp.py"), "--source", str(self.source),
             "--target", str(self.target), *flags], cwd=ROOT, capture_output=True, text=True, timeout=10,
        )

    def test_migration_preserves_rows_and_split_between_public_and_private(self):
        result = self.migrate()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "Migration: 5 source reports, 5 verified target reports.")
        self.assertEqual(self.source_hash(), self.original_hash)
        with closing(sqlite3.connect(self.target)) as db:
            self.assertEqual(db.execute("SELECT key FROM settings").fetchall(), [])
            self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='sessions'").fetchone())
            self.assertEqual(db.execute("SELECT id,requestId,status FROM reports ORDER BY id").fetchall(),
                             [(f"legacy-{i}", f"legacy-{i}", status) for i, status in
                              enumerate(("Open", "Open", "Returned", "Returned", "Open"), 1)])
            created, signature = db.execute("SELECT created,fingerprint FROM reports WHERE id='legacy-1'").fetchone()
        self.assertEqual(created, int(self.recent.timestamp()))
        self.assertEqual(signature, fingerprint({
            "type": "found", "title": "Test notebook", "category": "Stationery", "color": "",
            "location": "Library", "date": "", "time": "", "description": "", "contact": "Test Reporter",
            "contactDetail": "reporter@example.invalid", "privateClue": "",
        }))
        with running_server(self.target) as origin:
            client = Client(origin)
            self.assertEqual(client.call("/api/admin")[0], 401)
            status, response = client.call("/api/reports")
            self.assertEqual(status, 200)
            public = response["reports"]
            self.assertEqual({row["id"] for row in public}, {f"legacy-{i}" for i in range(1, 5)})
            for row in public:
                self.assertFalse({"contact", "contactDetail", "privateClue"} & row.keys())
                self.assertTrue(all(row[field] == "" for field in ("color", "date", "time", "description")))
            self.assertEqual(login(client)[0], 200)
            status, response = client.call("/api/admin")
            self.assertEqual(status, 200)
            self.assertEqual(len(response["reports"]), 5)
            for row in response["reports"]:
                self.assertEqual((row["contact"], row["contactDetail"], row["privateClue"]),
                                 ("Test Reporter", "reporter@example.invalid", ""))
        with running_server(self.target, FINDIT_PRIVATE_DAYS="7") as origin:
            client = Client(origin)
            self.assertEqual(login(client)[0], 200)
            self.assertEqual(len(client.call("/api/admin")[1]["reports"]), 4)
        self.assertEqual(self.source_hash(), self.original_hash)

    def test_dry_run_writes_nothing_and_existing_target_is_refused(self):
        result = self.migrate("--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "Dry run: 5 source reports, 5 verified target reports.")
        self.assertEqual(set(self.source.parent.iterdir()), {self.source})
        self.target.write_bytes(b"existing target")
        result = self.migrate()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Target already exists", result.stderr)
        self.assertEqual(self.target.read_bytes(), b"existing target")
        self.assertEqual(self.source_hash(), self.original_hash)

    def test_bad_source_row_does_not_leave_a_partial_database(self):
        with closing(sqlite3.connect(self.source)) as db, db:
            db.execute("UPDATE reports SET createdAt='bad timestamp' WHERE id=5")
        original = self.source_hash()
        result = self.migrate()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid status or creation timestamp", result.stderr)
        self.assertEqual(set(self.source.parent.iterdir()), {self.source})
        self.assertEqual(self.source_hash(), original)

    def test_wal_database_can_be_migrated_from_a_snapshot(self):
        live = self.source
        snapshot = live.with_name("backup.db")
        with closing(sqlite3.connect(live)) as db:
            db.execute("PRAGMA journal_mode=WAL")
            with db:
                db.execute("INSERT INTO reports(type,title,category) VALUES ('lost','Test pen','Stationery')")
            original = self.source_hash()
            result = self.migrate()
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("standalone SQLite backup", result.stderr)
            self.assertFalse(self.target.exists())
            with closing(sqlite3.connect(snapshot)) as backup:
                db.backup(backup)
            self.source = snapshot
            result = self.migrate()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "Migration: 6 source reports, 6 verified target reports.")
            self.assertEqual(hashlib.sha256(live.read_bytes()).hexdigest(), original)
