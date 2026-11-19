"""Exercise the staging server through HTTP, using only disposable data."""

import datetime as dt
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import uuid


ROOT = Path(__file__).resolve().parents[1]


class Client:
    def __init__(self, origin):
        self.origin = origin
        self.http = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        )

    def call(self, path, data=None):
        req = urllib.request.Request(
            self.origin + path,
            data=None if data is None else json.dumps(data).encode(),
            headers={"Content-Type": "application/json", "Origin": self.origin},
        )
        try:
            response = self.http.open(req, timeout=4)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)


class StudentJourney(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Path(self.temp.name) / "test.sqlite3"
        self.password = secrets.token_urlsafe(24)
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        self.origin = f"http://127.0.0.1:{self.port}"
        self.finder = Client(self.origin)
        self.owner = Client(self.origin)
        self.staff = Client(self.origin)
        self.server = None
        self.addCleanup(self.stop_server)
        self.start_server()

    def start_server(self):
        env = {
            **os.environ,
            "FINDIT_DB": str(self.db),
            "FINDIT_PORT": str(self.port),
            "FINDIT_USERNAME": "test-staff",
            "FINDIT_PASSWORD": self.password,
            "FINDIT_DESK": "Test desk",
            "FINDIT_HOURS": "Test hours",
            "FINDIT_CONTACT": "test@example.invalid",
        }
        self.server = subprocess.Popen(
            [sys.executable, str(ROOT / "server.py")],
            cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        for _ in range(100):
            if self.server.poll() is not None:
                self.fail(self.server.stderr.read().decode(errors="replace"))
            try:
                if self.finder.call("/api/config")[0] == 200:
                    return
            except (OSError, urllib.error.URLError):
                pass
            time.sleep(0.05)
        self.fail("The local staging server did not become ready.")

    def stop_server(self):
        if self.server:
            if self.server.poll() is None:
                self.server.terminate()
            try:
                self.server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.server.kill()
                self.server.wait()
            self.server.stderr.close()
            self.server = None

    def ok(self, client, path, data=None):
        status, payload = client.call(path, data)
        self.assertTrue(200 <= status < 300, (status, payload))
        return payload

    def report(self, kind):
        return {
            "requestId": str(uuid.uuid4()), "type": kind, "title": "Blue notebook",
            "category": "Books & stationery", "color": "", "location": "Library",
            "date": dt.date.today().isoformat(), "time": "",
            "description": "A notebook with a plain blue cover.",
            "contact": f"Test {kind} reporter",
            "contactDetail": f"{kind}@example.invalid", "privateClue": "",
        }

    def test_report_claim_and_handover(self):
        config = self.ok(self.owner, "/api/config")
        self.assertEqual(config["desk"], "Test desk")
        self.assertEqual(config["hours"], "Test hours")
        self.assertEqual(self.ok(self.owner, "/api/reports")["reports"], [])

        found = self.report("found")
        found["privateClue"] = "Interior cover has a red square."
        lost = self.report("lost")
        first = self.ok(self.finder, "/api/reports", found)
        retry = self.ok(self.finder, "/api/reports", found)
        self.assertEqual(first["reference"], retry["reference"])
        other = self.ok(self.owner, "/api/reports", lost)
        public = self.ok(self.owner, "/api/reports")["reports"]
        self.assertEqual({r["id"] for r in public}, {first["id"], other["id"]})
        for row in public:
            self.assertFalse({"contact", "contactDetail", "privateClue"} & row.keys())
        self.assertNotIn(found["privateClue"], json.dumps(public))

        self.stop_server()
        self.start_server()
        self.assertEqual(len(self.ok(self.owner, "/api/reports")["reports"]), 2)
        self.assertEqual(self.ok(self.finder, "/api/reports", found)["id"], first["id"])
        claim = {
            "requestId": str(uuid.uuid4()), "reportId": first["id"],
            "linkedReportId": other["id"], "contact": "Test Claimant",
            "contactDetail": "claimant@example.invalid",
            "proof": "I drew a red square inside the cover.",
        }
        ref = self.ok(self.owner, "/api/claims", claim)["reference"]
        self.assertEqual(self.ok(self.owner, "/api/claims", claim)["reference"], ref)
        self.assertFalse(self.ok(self.owner, "/api/session")["authenticated"])
        self.assertIn(self.owner.call("/api/admin")[0], (401, 403))
        self.ok(self.staff, "/api/login", {"username": "test-staff", "password": self.password})
        self.assertTrue(self.ok(self.staff, "/api/session")["authenticated"])
        queue = self.ok(self.staff, "/api/admin")
        self.assertEqual([c["reference"] for c in queue["claims"]], [ref])
        self.assertEqual(queue["claims"][0]["proof"], claim["proof"])
        self.assertEqual(next(r for r in queue["reports"] if r["id"] == first["id"])["privateClue"], found["privateClue"])
        self.ok(self.staff, "/api/claims/resolve", {
            "reference": ref, "decision": "Returned",
            "note": "Verified inside cover and handed notebook to owner.",
        })
        queue = self.ok(self.staff, "/api/admin")
        self.assertEqual(queue["claims"][0]["status"], "Returned")
        self.assertEqual([r["status"] for r in queue["reports"]], ["Returned", "Returned"])
        self.assertTrue(any(h["createdAt"] and h["actor"] and h["reference"] == ref for h in queue["history"]))
        self.ok(self.staff, "/api/logout", {})
        self.assertFalse(self.ok(self.staff, "/api/session")["authenticated"])
        self.assertIn(self.staff.call("/api/admin")[0], (401, 403))
        self.assertIn(self.owner.call("/api/admin")[0], (401, 403))

    def test_backup_restores_a_receipt(self):
        report = self.report("lost")
        receipt = self.ok(self.owner, "/api/reports", report)
        restored = self.db.with_name("restore.sqlite3")
        with sqlite3.connect(self.db) as source, sqlite3.connect(restored) as backup:
            source.backup(backup)
        source.close()
        backup.close()
        self.stop_server()
        self.db = restored
        self.start_server()
        self.assertEqual(self.ok(self.owner, "/api/reports", report)["reference"], receipt["reference"])
        rows = self.ok(self.owner, "/api/reports")["reports"]
        self.assertEqual([r["id"] for r in rows], [receipt["id"]])


if __name__ == "__main__":
    unittest.main()
