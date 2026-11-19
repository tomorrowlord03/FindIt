"""Coordinator password and client-IP behavior through the HTTP server."""

import os
import socket
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from contextlib import closing, contextmanager
from pathlib import Path
from urllib.error import URLError

from test_journey import Client, ROOT


BOOTSTRAP = "test-initial-password"
REPLACEMENT = "test-new-password with spaces "


@contextmanager
def running_server(database, **settings):
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    env = {key: value for key, value in os.environ.items() if not key.startswith("FINDIT_")}
    env.update(FINDIT_DB=str(database), FINDIT_HOST="127.0.0.1", FINDIT_PORT=str(port),
               FINDIT_ORIGIN=origin, FINDIT_USERNAME="admin", FINDIT_PASSWORD=BOOTSTRAP)
    env.update(settings)
    with subprocess.Popen([sys.executable, str(ROOT / "server.py")], cwd=ROOT, env=env,
                          stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                          creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0)) as process:
        try:
            for _ in range(100):
                if process.poll() is not None:
                    raise RuntimeError(process.stderr.read().decode(errors="replace"))
                try:
                    if Client(origin).call("/api/config")[0] == 200:
                        break
                except (OSError, URLError):
                    time.sleep(0.05)
            else:
                raise RuntimeError("FindIt did not become ready.")
            yield origin
        finally:
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def login(client, password=BOOTSTRAP):
    return client.call("/api/login", {"username": "admin", "password": password})


def change(client, current=BOOTSTRAP, new=REPLACEMENT):
    return client.call("/api/admin/change-password", {"currentPassword": current, "newPassword": new})


class CoordinatorPassword(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.db = Path(temp.name) / "test.sqlite3"

    def test_password_persists_and_revokes_other_sessions(self):
        with running_server(self.db) as origin:
            staff, other, anonymous = (Client(origin) for _ in range(3))
            self.assertEqual(change(anonymous)[0], 401)
            self.assertEqual(login(staff)[0], 200)
            self.assertEqual(login(other)[0], 200)
            staff.http.addheaders = [("Sec-Fetch-Site", "cross-site")]
            self.assertEqual(change(staff)[0], 403)
            staff.http.addheaders = []
            self.assertEqual(change(staff, new="too short")[0], 400)
            self.assertEqual(change(staff), (200, {"changed": True}))
            self.assertEqual(other.call("/api/admin")[0], 401)
            self.assertEqual(staff.call("/api/admin")[0], 200)
            self.assertEqual(login(anonymous)[0], 401)
            self.assertEqual(login(anonymous, REPLACEMENT)[0], 200)

        with closing(sqlite3.connect(self.db)) as db:
            (stored,), = db.execute("SELECT val FROM settings").fetchall()
        salt, digest = (bytes.fromhex(part) for part in stored.split(":"))
        self.assertEqual((len(salt), len(digest)), (16, 32))
        self.assertNotIn(REPLACEMENT, stored)

        with running_server(self.db) as origin:
            staff = Client(origin)
            self.assertEqual(login(staff)[0], 401)
            self.assertEqual(login(staff, REPLACEMENT)[0], 200)
        with running_server(self.db, FINDIT_PASSWORD="") as origin:
            self.assertEqual(login(Client(origin), REPLACEMENT)[0], 200)

    def test_untrusted_proxy_cannot_bypass_login_limit(self):
        with running_server(self.db) as origin:
            client = Client(origin)
            for attempt in range(5):
                client.http.addheaders = [("X-Real-IP", f"192.0.2.{attempt + 1}")]
                self.assertEqual(login(client, "wrong password")[0], 401)
            client.http.addheaders = [("X-Real-IP", "192.0.2.100")]
            status, response = login(client)
            self.assertEqual(status, 429)
            self.assertIn("15 minutes", response["error"])

    def test_trusted_proxy_isolates_clients_and_limits_password_changes(self):
        with running_server(self.db, FINDIT_TRUST_PROXY="1") as origin:
            staff, other = Client(origin), Client(origin)
            staff.http.addheaders = [("X-Real-IP", "192.0.2.1")]
            other.http.addheaders = [("X-Real-IP", "192.0.2.2")]
            self.assertEqual(login(staff)[0], 200)
            self.assertEqual(login(other)[0], 200)
            for _ in range(5):
                self.assertEqual(change(staff, current="wrong password")[0], 403)
            self.assertEqual(change(staff)[0], 429)
            self.assertEqual(login(staff)[0], 200)
            for _ in range(5):
                self.assertEqual(login(staff, "wrong password")[0], 401)
            self.assertEqual(login(staff)[0], 429)
            self.assertEqual(change(other)[0], 200)
            self.assertEqual(login(other, REPLACEMENT)[0], 200)
