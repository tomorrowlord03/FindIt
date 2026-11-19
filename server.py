"""FindIt staging server. Python 3.10+ and its standard SQLite module."""
from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import sqlite3
import threading
import time
from contextlib import closing
from datetime import date, datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie, CookieError
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

BASE = Path(__file__).resolve().parent
DAY = 86_400
PUBLIC_DAYS = 7
PUBLIC = "id,type,title,category,color,location,date,time,description,status"
PRIVATE = PUBLIC + ",contact,contactDetail,privateClue"
ASSETS = {"index.html", "styles.css", "algorithms.js", "app.js"}
PAGES = {"/", "/dashboard", "/report", "/reports", "/browse", "/matches", "/coordinator", "/admin", "/help"}
SCHEMA = """
CREATE TABLE IF NOT EXISTS reports (
 id TEXT PRIMARY KEY, requestId TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL,
 type TEXT NOT NULL, title TEXT NOT NULL, category TEXT NOT NULL, color TEXT NOT NULL,
 location TEXT NOT NULL, date TEXT NOT NULL, time TEXT NOT NULL, description TEXT NOT NULL,
 contact TEXT NOT NULL, contactDetail TEXT NOT NULL, privateClue TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'Open', created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS claims (
 reference TEXT PRIMARY KEY, requestId TEXT UNIQUE NOT NULL, fingerprint TEXT NOT NULL,
 reportId TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
 linkedReportId TEXT REFERENCES reports(id) ON DELETE SET NULL, contact TEXT NOT NULL,
 contactDetail TEXT NOT NULL, proof TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'Pending',
 created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS history (
 seq INTEGER PRIMARY KEY, reference TEXT NOT NULL, action TEXT NOT NULL, actor TEXT NOT NULL,
 note TEXT NOT NULL, created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS reports_created ON reports(created);
CREATE INDEX IF NOT EXISTS claims_report ON claims(reportId);
"""


class Failure(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def string(data, key, limit, required=True):
    value = data.get(key, "")
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise Failure(400, f"Check {key}.")
    return value.strip()


def ticket(prefix):
    return prefix + "-" + secrets.token_hex(6).upper()


def fingerprint(values):
    encoded = json.dumps(values, ensure_ascii=False, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


def receipt(db, table, column, key, signature):
    row = db.execute(f"SELECT {column},fingerprint FROM {table} WHERE requestId=?", (key,)).fetchone()
    if row and row["fingerprint"] != signature:
        raise Failure(409, "This submission reference was already used for different details.")
    return row[0] if row else None


def active_report(db, identifier):
    row = db.execute("SELECT * FROM reports WHERE id=?", (identifier,)).fetchone()
    if not row or row["status"] != "Open":
        raise Failure(409, "This report is no longer available.")
    return row


def create_report(db, data, now):
    key = string(data, "requestId", 128)
    fields = [
        ("type", 8, True), ("title", 100, True), ("category", 80, True), ("color", 60, False),
        ("location", 160, True), ("date", 10, True), ("time", 5, False),
        ("description", 1000, True), ("contact", 100, True), ("contactDetail", 160, True),
        ("privateClue", 500, False),
    ]
    values = {k: string(data, k, limit, req) for k, limit, req in fields}
    if values["type"] not in ("lost", "found"):
        raise Failure(400, "Choose lost or found.")
    try:
        if date.fromisoformat(values["date"]).isoformat() != values["date"]:
            raise ValueError()
        if values["time"]:
            datetime.strptime(values["time"], "%H:%M")
    except ValueError:
        raise Failure(400, "Enter a valid date and time.")
    signature = fingerprint(values)
    identifier = receipt(db, "reports", "id", key, signature)
    if not identifier:
        identifier = ticket("FI")
        columns = ",".join(values)
        params = [identifier, key, signature, now, *values.values()]
        marks = ",".join("?" for _ in params)
        db.execute(f"INSERT INTO reports(id,requestId,fingerprint,created,{columns}) VALUES ({marks})", params)
    return {"id": identifier, "reference": identifier}


def create_claim(db, data, now):
    key = string(data, "requestId", 128)
    report = string(data, "reportId", 100)
    linked = string(data, "linkedReportId", 100, False) or None
    contact = string(data, "contact", 100)
    detail = string(data, "contactDetail", 160)
    proof = string(data, "proof", 1000)
    signature = fingerprint([report, linked, contact, detail, proof])
    ref = receipt(db, "claims", "reference", key, signature)
    if ref:
        return {"reference": ref}
    row = active_report(db, report)
    if row["created"] < now - PUBLIC_DAYS * DAY:
        raise Failure(409, "This listing has expired.")
    if linked:
        other = active_report(db, linked)
        if other["type"] == row["type"] or other["created"] < now - PUBLIC_DAYS * DAY:
            raise Failure(400, "Choose an active report of the opposite type.")
    ref = ticket("CL")
    db.execute("""INSERT INTO claims(reference,requestId,fingerprint,reportId,linkedReportId,
               contact,contactDetail,proof,created) VALUES (?,?,?,?,?,?,?,?,?)""",
               (ref, key, signature, report, linked, contact, detail, proof, now))
    return {"reference": ref}


def resolve_claim(db, data, now, actor):
    ref = string(data, "reference", 100)
    decision = string(data, "decision", 10)
    note = string(data, "note", 600)
    if decision not in ("Returned", "Declined"):
        raise Failure(400, "Choose a valid decision.")
    claim = db.execute("SELECT * FROM claims WHERE reference=?", (ref,)).fetchone()
    if not claim:
        raise Failure(404, "Claim not found.")
    if claim["status"] != "Pending":
        raise Failure(409, "This claim has already been reviewed.")
    linked = string(data, "linkedReportId", 100, False) or claim["linkedReportId"]
    if decision == "Returned":
        row = active_report(db, claim["reportId"])
        if linked and active_report(db, linked)["type"] == row["type"]:
            raise Failure(400, "Choose a complementary lost/found report.")
        ids = (claim["reportId"], linked)
        db.execute("UPDATE reports SET status='Returned' WHERE id IN (?,?)", ids)
        other = db.execute("""SELECT reference FROM claims WHERE reference<>? AND status='Pending'
                AND (reportId IN (?,?) OR linkedReportId IN (?,?))""", (ref, *ids, *ids)).fetchall()
        for record in other:
            db.execute("UPDATE claims SET status='Declined' WHERE reference=?", (record[0],))
            db.execute("INSERT INTO history(reference,action,actor,note,created) VALUES (?,?,?,?,?)",
                       (record[0], "Declined", actor, "Item returned on another claim.", now))
    db.execute("UPDATE claims SET status=?, linkedReportId=? WHERE reference=?",
               (decision, linked if decision == "Returned" else claim["linkedReportId"], ref))
    db.execute("INSERT INTO history(reference,action,actor,note,created) VALUES (?,?,?,?,?)",
               (ref, decision, actor, note, now))
    return {"reference": ref, "status": decision}


class App(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, database, password, username, private_days):
        self.dbpath = database
        self.private_days = private_days
        self.username = username
        self.salt = secrets.token_bytes(16)
        self.password_hash = self.derive(password)
        self.lock = threading.Lock()
        self.sessions = {}
        self.failures = {}
        self.next_cleanup = 0
        with closing(self.connect()) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript(SCHEMA)
        super().__init__(address, Handler)

    def derive(self, value):
        return hashlib.pbkdf2_hmac("sha256", value.encode(), self.salt, 600000)

    def connect(self):
        db = sqlite3.connect(self.dbpath, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        return db

    def cleanup(self, now):
        with self.lock:
            if now < self.next_cleanup:
                return
            cutoff = now - self.private_days * DAY
            with closing(self.connect()) as db, db:
                db.execute("DELETE FROM reports WHERE created<?", (cutoff,))
                db.execute("DELETE FROM history WHERE created<?", (cutoff,))
            self.next_cleanup = now + 60
            self.sessions = {k: t for k, t in self.sessions.items() if t > now}
            self.failures = {k: v for k, v in self.failures.items() if v[1] > now}

    def service_actions(self):
        try:
            self.cleanup(int(time.time()))
        except sqlite3.Error:
            # Retry transient I/O failures without taking the public server down.
            self.next_cleanup = int(time.time()) + 15


class Handler(BaseHTTPRequestHandler):
    server_version = "FindIt"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, fmt, *args):
        # Never record contacts, login attempts, bodies, query strings or receipts.
        pass

    def reply(self, result, status=200, content_type="application/json", cookie=None):
        data = result if isinstance(result, bytes) else json.dumps(result).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy",
                         "default-src 'self'; script-src 'self'; style-src 'self'; "
                         "img-src 'self' data:; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(data)

    def token(self):
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except CookieError:
            return ""
        return cookie["findit_session"].value if "findit_session" in cookie else ""

    def expiry(self):
        with self.server.lock:
            expiry = self.server.sessions.get(self.token(), 0)
        return expiry if expiry > time.time() else 0

    def require_admin(self):
        if not self.expiry():
            raise Failure(401, "Sign in to the coordinator desk.")

    def read_body(self):
        origin = self.headers.get("Origin")
        expected = os.environ.get("FINDIT_ORIGIN") or "http://" + self.headers.get("Host", "")
        if (origin and origin != expected) or self.headers.get("Sec-Fetch-Site") == "cross-site":
            raise Failure(403, "Cross-site submission denied.")
        if self.headers.get_content_type() != "application/json":
            raise Failure(415, "Send application/json.")
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise Failure(400, "Invalid request size.")
        if not 0 < length <= 16384:
            raise Failure(413, "Invalid submission size.")
        try:
            body = json.loads(self.rfile.read(length))
        except (ValueError, UnicodeError):
            raise Failure(400, "Invalid JSON.")
        if not isinstance(body, dict):
            raise Failure(400, "Expected JSON object.")
        return body

    def cookie(self, token, age):
        secure = "; Secure" if os.getenv("FINDIT_ORIGIN", "").startswith("https://") else ""
        return f"findit_session={token}; Path=/; HttpOnly; SameSite=Strict; Max-Age={age}{secure}"

    def login(self, data, now):
        app = self.server
        username = string(data, "username", 100)
        password = data.get("password")
        if not isinstance(password, str) or len(password) > 1024:
            raise Failure(400, "Check password.")
        ip = self.client_address[0]
        with app.lock:
            attempts, end = app.failures.get(ip, (0, now + 60))
            if end <= now:
                attempts, end = 0, now + 60
            if attempts >= 8:
                raise Failure(429, "Too many attempts. Try again in one minute.")
            app.failures[ip] = (attempts + 1, end)
        if not hmac.compare_digest(app.derive(password), app.password_hash) or username != app.username:
            raise Failure(401, "The username or password is incorrect.")
        token = secrets.token_urlsafe(32)
        with app.lock:
            app.sessions.pop(self.token(), None)
            app.sessions[token] = now + 1800
            app.failures.pop(ip, None)
        self.reply({"authenticated": True, "expiresAt": now + 1800}, cookie=self.cookie(token, 1800))

    def dispatch(self, method):
        path = urlsplit(self.path).path
        now = int(time.time())
        app = self.server
        if method == "GET":
            if path == "/api/config":
                return self.reply({"desk": os.getenv("FINDIT_DESK", ""), "hours": os.getenv("FINDIT_HOURS", ""),
                                   "contact": os.getenv("FINDIT_CONTACT", ""), "retentionDays": PUBLIC_DAYS,
                                   "privateRetentionDays": app.private_days})
            if path == "/api/session":
                expiry = self.expiry()
                return self.reply({"authenticated": bool(expiry), "expiresAt": expiry})
            if path == "/api/reports":
                with closing(app.connect()) as db:
                    rows = db.execute(f"SELECT {PUBLIC} FROM reports WHERE created>=? ORDER BY created DESC,rowid DESC",
                                      (now - DAY * PUBLIC_DAYS,))
                    return self.reply({"reports": [dict(r) for r in rows]})
            if path == "/api/admin":
                self.require_admin()
                with closing(app.connect()) as db:
                    db.execute("BEGIN")
                    reports = [dict(r) for r in db.execute(f"SELECT {PRIVATE} FROM reports ORDER BY rowid DESC")]
                    claims = [dict(r) for r in db.execute("SELECT reference,reportId,linkedReportId,contact,contactDetail,proof,status FROM claims ORDER BY rowid DESC")]
                    history = []
                    for r in db.execute("SELECT reference,action,actor,note,created FROM history ORDER BY seq DESC"):
                        hist = dict(r)
                        hist["createdAt"] = datetime.fromtimestamp(hist.pop("created"), timezone.utc).isoformat()
                        history.append(hist)
                    return self.reply({"reports": reports, "claims": claims, "history": history,
                                       "expiresAt": self.expiry()})
            filename = "index.html" if path in PAGES else path.removeprefix("/")
            if filename not in ASSETS:
                raise Failure(404, "Not found.")
            return self.reply((BASE / filename).read_bytes(), content_type=mimetypes.guess_type(filename)[0] or "application/octet-stream")

        data = self.read_body()
        if path == "/api/login":
            return self.login(data, now)
        if path == "/api/logout":
            with app.lock:
                app.sessions.pop(self.token(), None)
            return self.reply({"authenticated": False}, cookie=self.cookie("", 0))
        if path not in {"/api/reports", "/api/claims", "/api/claims/resolve"}:
            raise Failure(404, "Not found.")
        if path == "/api/claims/resolve":
            self.require_admin()
        with closing(app.connect()) as db, db:
            db.execute("BEGIN IMMEDIATE")
            if path == "/api/reports":
                result = create_report(db, data, now)
            elif path == "/api/claims":
                result = create_claim(db, data, now)
            else:
                result = resolve_claim(db, data, now, app.username)
        return self.reply(result)

    def handle_method(self, method):
        try:
            self.dispatch(method)
        except Failure as error:
            self.reply({"error": str(error)}, error.status)
        except sqlite3.Error:
            self.reply({"error": "Storage is temporarily unavailable. Retry with the same reference."}, HTTPStatus.SERVICE_UNAVAILABLE)
        except (ConnectionError, TimeoutError):
            pass

    def do_GET(self):
        self.handle_method("GET")

    def do_POST(self):
        self.handle_method("POST")


def main():
    password = os.getenv("FINDIT_PASSWORD", "")
    if len(password) < 12:
        raise SystemExit("Set FINDIT_PASSWORD to a unique password of at least 12 characters.")
    private_days = int(os.getenv("FINDIT_PRIVATE_DAYS", "30"))
    if private_days < PUBLIC_DAYS:
        raise SystemExit("FINDIT_PRIVATE_DAYS must be at least 7.")
    default_db = Path.home() / ".findit" / "reports.sqlite3"
    database = Path(os.getenv("FINDIT_DB", str(default_db))).resolve()
    if database == BASE or BASE in database.parents:
        raise SystemExit("Choose a private database location outside the project directory.")
    os.umask(0o077)
    database.parent.mkdir(parents=True, exist_ok=True)
    host, port = os.getenv("FINDIT_HOST", "127.0.0.1"), int(os.getenv("FINDIT_PORT", "5500"))
    with App((host, port), database, password, os.getenv("FINDIT_USERNAME", "coordinator"), private_days) as app:
        app.cleanup(int(time.time()))
        print(f"FindIt ready at http://{host}:{app.server_port}", flush=True)
        app.serve_forever()


if __name__ == "__main__":
    main()
