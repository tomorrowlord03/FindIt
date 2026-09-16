// FindIt backend — C++17 REST API over SQLite (canvas task t-019d698c).
//
// Run with cwd = server/cpp (the defaults below assume that):
//     ./build/findit-server
//
// Env:
//   PORT             listen port, 0 = OS picks one (printed on stdout)   [3000]
//   FINDIT_DB        SQLite database file                                [./findit.db]
//   FINDIT_WEB       folder served for non-API GETs                      [../../repo]
//   ADMIN_USERNAME   coordinator login                                   [admin]
//   ADMIN_PASSWORD   coordinator password                                [password]
//
// API
//   POST  /reports            {type,title,category,color,location,date,time,contact,contactDetail,description}
//   GET   /reports            public list; send "Authorization: Bearer <token>" to include contactDetail
//   POST  /admin/login        {username,password} -> {token,expiresIn}
//   PATCH /admin/reports/:id  Bearer token + {status}
//
// Retention: reports older than 7 days are purged at startup and every hour (idempotent).

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <winsock2.h>
#include <ws2tcpip.h>
#include <bcrypt.h>
#else
#include <sys/socket.h>
#include <sys/types.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
using SOCKET = int;
#define INVALID_SOCKET (-1)
#define SOCKET_ERROR (-1)
#define closesocket close
#define SD_SEND SHUT_WR
#define WSAGetLastError() (errno)
#endif

#include <sqlite3.h>

#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <fstream>
#include <map>
#include <string>
#include <thread>
#include <utility>
#include <vector>

// ---------------------------------------------------------------- config ----

static const size_t kMaxHeaderBytes = 16 * 1024;
static const size_t kMaxBodyBytes = 256 * 1024;
static const int kSessionSeconds = 3600;   // matches the 1h token the Node server issued
static const int kPurgeIntervalSec = 3600;

static sqlite3* g_db = nullptr;
static std::string g_webRoot = "../../repo";
static std::string g_adminUser = "admin";
static std::string g_adminPass = "password";

// ----------------------------------------------------------- tiny JSON ------
// Only what this API accepts: one flat object whose values are strings.
// ponytail: no arrays/nested objects/non-BMP escapes — swap in a real parser if the API grows.

static void appendUtf8(std::string& out, unsigned cp) {
  if (cp < 0x80) {
    out += (char)cp;
  } else if (cp < 0x800) {
    out += (char)(0xC0 | (cp >> 6));
    out += (char)(0x80 | (cp & 0x3F));
  } else {
    out += (char)(0xE0 | (cp >> 12));
    out += (char)(0x80 | ((cp >> 6) & 0x3F));
    out += (char)(0x80 | (cp & 0x3F));
  }
}

static bool jsonParseString(const std::string& s, size_t& i, std::string& out) {
  if (i >= s.size() || s[i] != '"') return false;
  ++i;
  out.clear();
  while (i < s.size()) {
    char c = s[i++];
    if (c == '"') return true;
    if (c != '\\') { out += c; continue; }
    if (i >= s.size()) return false;
    char e = s[i++];
    switch (e) {
      case '"': out += '"'; break;
      case '\\': out += '\\'; break;
      case '/': out += '/'; break;
      case 'b': out += '\b'; break;
      case 'f': out += '\f'; break;
      case 'n': out += '\n'; break;
      case 'r': out += '\r'; break;
      case 't': out += '\t'; break;
      case 'u': {
        unsigned cp = 0;
        if (i + 4 > s.size()) return false;
        for (int k = 0; k < 4; ++k) {
          char h = s[i++];
          cp <<= 4;
          if (h >= '0' && h <= '9') cp |= (unsigned)(h - '0');
          else if (h >= 'a' && h <= 'f') cp |= (unsigned)(h - 'a' + 10);
          else if (h >= 'A' && h <= 'F') cp |= (unsigned)(h - 'A' + 10);
          else return false;
        }
        appendUtf8(out, cp);
        break;
      }
      default: return false;
    }
  }
  return false;
}

static bool jsonField(const std::string& body, const std::string& key, std::string& out) {
  size_t i = 0;
  while (i < body.size() && (unsigned char)body[i] <= ' ') ++i;
  if (i >= body.size() || body[i] != '{') return false;
  ++i;
  while (true) {
    while (i < body.size() && (unsigned char)body[i] <= ' ') ++i;
    if (i >= body.size() || body[i] == '}') return false;   // key absent
    std::string k;
    if (!jsonParseString(body, i, k)) return false;
    while (i < body.size() && (unsigned char)body[i] <= ' ') ++i;
    if (i >= body.size() || body[i] != ':') return false;
    ++i;
    while (i < body.size() && (unsigned char)body[i] <= ' ') ++i;
    if (i < body.size() && body[i] == '"') {
      std::string v;
      if (!jsonParseString(body, i, v)) return false;
      if (k == key) { out = v; return true; }
    } else {
      // Non-string value: skip it so a later key can still be read.
      int depth = 0;
      while (i < body.size()) {
        char c = body[i];
        if (c == '"') { std::string t; if (!jsonParseString(body, i, t)) return false; continue; }
        if (c == '{' || c == '[') ++depth;
        else if (c == '}' || c == ']') { if (depth == 0) break; --depth; }
        else if (c == ',' && depth == 0) break;
        ++i;
      }
      if (k == key) return false;   // present, but not a string
    }
    while (i < body.size() && (unsigned char)body[i] <= ' ') ++i;
    if (i < body.size() && body[i] == ',') { ++i; continue; }
    return false;
  }
}

static std::string jsonEscape(const std::string& s) {
  std::string o;
  o.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"': o += "\\\""; break;
      case '\\': o += "\\\\"; break;
      case '\n': o += "\\n"; break;
      case '\r': o += "\\r"; break;
      case '\t': o += "\\t"; break;
      case '\b': o += "\\b"; break;
      case '\f': o += "\\f"; break;
      default:
        if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
        else o += (char)c;
    }
  }
  return o;
}

static std::string errorJson(const std::string& message) {
  return "{\"error\":\"" + jsonEscape(message) + "\"}";
}

// ------------------------------------------------------------------ HTTP ----

struct Request {
  std::string method;
  std::string path;    // decoded path, e.g. /admin/reports/7
  std::string body;
  std::map<std::string, std::string> headers;   // lowercased names
  size_t declaredLength = 0;
};

struct Response {
  int code = 200;
  std::string status = "OK";
  std::string contentType = "application/json";
  std::string body;
  std::vector<std::pair<std::string, std::string>> headers;
};

static std::string trim(const std::string& s) {
  size_t a = 0, b = s.size();
  while (a < b && (unsigned char)s[a] <= ' ') ++a;
  while (b > a && (unsigned char)s[b - 1] <= ' ') --b;
  return s.substr(a, b - a);
}

static bool parseRequest(const std::string& raw, size_t headerEnd, Request& req) {
  std::string head = raw.substr(0, headerEnd);
  size_t lineEnd = head.find("\r\n");
  std::string requestLine = lineEnd == std::string::npos ? head : head.substr(0, lineEnd);

  size_t sp1 = requestLine.find(' ');
  size_t sp2 = sp1 == std::string::npos ? std::string::npos : requestLine.find(' ', sp1 + 1);
  if (sp1 == std::string::npos || sp2 == std::string::npos) return false;
  req.method = requestLine.substr(0, sp1);
  std::string target = requestLine.substr(sp1 + 1, sp2 - sp1 - 1);
  size_t q = target.find('?');
  req.path = q == std::string::npos ? target : target.substr(0, q);
  if (req.path.empty() || req.path[0] != '/') return false;

  size_t pos = lineEnd == std::string::npos ? head.size() : lineEnd + 2;
  while (pos < head.size()) {
    size_t end = head.find("\r\n", pos);
    if (end == std::string::npos) end = head.size();
    std::string line = head.substr(pos, end - pos);
    pos = end + 2;
    size_t colon = line.find(':');
    if (colon == std::string::npos) continue;
    std::string name = line.substr(0, colon);
    for (char& c : name) c = (char)tolower((unsigned char)c);
    req.headers[name] = trim(line.substr(colon + 1));
  }

  auto len = req.headers.find("content-length");
  req.declaredLength = len == req.headers.end() ? 0 : (size_t)strtoull(len->second.c_str(), nullptr, 10);
  req.body = raw.size() > headerEnd + 4 ? raw.substr(headerEnd + 4) : std::string();
  return true;
}

static void sendResponse(SOCKET client, const Response& res) {
  std::string head = "HTTP/1.1 " + std::to_string(res.code) + " " + res.status + "\r\n";
  head += "Content-Type: " + res.contentType + "\r\n";
  head += "Content-Length: " + std::to_string(res.body.size()) + "\r\n";
  head += "Access-Control-Allow-Origin: *\r\n";
  head += "Access-Control-Allow-Methods: GET, POST, PATCH, OPTIONS\r\n";
  head += "Access-Control-Allow-Headers: Content-Type, Authorization\r\n";
  head += "Connection: close\r\n";   // ponytail: one request per connection keeps the parser small
  for (const auto& h : res.headers) head += h.first + ": " + h.second + "\r\n";
  head += "\r\n";

  std::string out = head + res.body;
  size_t sent = 0;
  while (sent < out.size()) {
    int n = send(client, out.data() + sent, (int)(out.size() - sent), 0);
    if (n <= 0) break;
    sent += (size_t)n;
  }
}

// -------------------------------------------------------------- database ----

static std::string colText(sqlite3_stmt* st, int i) {
  const unsigned char* p = sqlite3_column_text(st, i);
  return p ? std::string(reinterpret_cast<const char*>(p)) : std::string();
}

static void dbExecOrDie(const char* sql) {
  char* err = nullptr;
  if (sqlite3_exec(g_db, sql, nullptr, nullptr, &err) != SQLITE_OK) {
    fprintf(stderr, "findit: sqlite error: %s\n", err ? err : "(unknown)");
    sqlite3_free(err);
    exit(1);
  }
}

static const char* kStatuses[] = {"Open", "Possible Match", "Claimed", "Returned"};

static bool validStatus(const std::string& s) {
  for (const char* candidate : kStatuses) if (s == candidate) return true;
  return false;
}

// Deletes reports past the 7-day retention window plus expired sessions.
static int purgeExpired() {
  if (sqlite3_exec(g_db, "DELETE FROM reports WHERE createdAt < datetime('now','-7 days')",
                   nullptr, nullptr, nullptr) != SQLITE_OK) {
    return 0;
  }
  int removed = sqlite3_changes(g_db);
  sqlite3_exec(g_db, "DELETE FROM sessions WHERE expiresAt <= strftime('%s','now')", nullptr, nullptr, nullptr);
  return removed;
}

static const char* kReportColumns =
    "id, type, title, category, color, location, date, time, contact, contactDetail, description, status, createdAt";

static std::string reportJson(sqlite3_stmt* st, bool withContactDetail) {
  std::string j = "{\"id\":" + std::to_string(sqlite3_column_int64(st, 0));
  j += ",\"type\":\"" + jsonEscape(colText(st, 1)) + "\"";
  j += ",\"title\":\"" + jsonEscape(colText(st, 2)) + "\"";
  j += ",\"category\":\"" + jsonEscape(colText(st, 3)) + "\"";
  j += ",\"color\":\"" + jsonEscape(colText(st, 4)) + "\"";
  j += ",\"location\":\"" + jsonEscape(colText(st, 5)) + "\"";
  j += ",\"date\":\"" + jsonEscape(colText(st, 6)) + "\"";
  j += ",\"time\":\"" + jsonEscape(colText(st, 7)) + "\"";
  j += ",\"contact\":\"" + jsonEscape(colText(st, 8)) + "\"";
  if (withContactDetail) j += ",\"contactDetail\":\"" + jsonEscape(colText(st, 9)) + "\"";
  j += ",\"description\":\"" + jsonEscape(colText(st, 10)) + "\"";
  j += ",\"status\":\"" + jsonEscape(colText(st, 11)) + "\"";
  j += ",\"createdAt\":\"" + jsonEscape(colText(st, 12)) + "\"}";
  return j;
}

// ------------------------------------------------------------------ auth ----

static bool constantTimeEquals(const std::string& a, const std::string& b) {
  if (a.size() != b.size()) return false;
  unsigned char diff = 0;
  for (size_t i = 0; i < a.size(); ++i) diff |= (unsigned char)(a[i] ^ b[i]);
  return diff == 0;
}

static std::string bearerToken(const Request& req) {
  auto it = req.headers.find("authorization");
  if (it == req.headers.end() || it->second.size() <= 7) return "";
  std::string scheme = it->second.substr(0, 7);
  for (char& c : scheme) c = (char)tolower((unsigned char)c);
  return scheme == "bearer " ? trim(it->second.substr(7)) : "";
}

static bool sessionValid(const std::string& token) {
  if (token.empty()) return false;
  sqlite3_stmt* st = nullptr;
  if (sqlite3_prepare_v2(g_db,
        "SELECT 1 FROM sessions WHERE token = ? AND expiresAt > strftime('%s','now')",
        -1, &st, nullptr) != SQLITE_OK) return false;
  sqlite3_bind_text(st, 1, token.c_str(), -1, SQLITE_TRANSIENT);
  bool ok = sqlite3_step(st) == SQLITE_ROW;
  sqlite3_finalize(st);
  return ok;
}

static std::string newToken() {
  unsigned char buf[32];
#ifdef _WIN32
  if (BCryptGenRandom(nullptr, buf, sizeof buf, BCRYPT_USE_SYSTEM_PREFERRED_RNG) != 0) {
    fprintf(stderr, "findit: could not read secure random bytes\n");
    exit(1);
  }
#else
  std::ifstream urandom("/dev/urandom", std::ios::binary);
  if (!urandom || !urandom.read(reinterpret_cast<char*>(buf), sizeof buf)) {
    fprintf(stderr, "findit: could not read /dev/urandom\n");
    exit(1);
  }
#endif
  static const char* hex = "0123456789abcdef";
  std::string s;
  s.reserve(64);
  for (unsigned char b : buf) { s += hex[b >> 4]; s += hex[b & 0x0F]; }
  return s;
}

// -------------------------------------------------------------- static ------

static const std::map<std::string, std::string>& mimeTypes() {
  static const std::map<std::string, std::string> types = {
      {"html", "text/html; charset=utf-8"}, {"htm", "text/html; charset=utf-8"},
      {"css", "text/css; charset=utf-8"},   {"js", "text/javascript; charset=utf-8"},
      {"mjs", "text/javascript; charset=utf-8"}, {"json", "application/json"},
      {"svg", "image/svg+xml"},             {"png", "image/png"},
      {"jpg", "image/jpeg"},                {"jpeg", "image/jpeg"},
      {"gif", "image/gif"},                 {"webp", "image/webp"},
      {"ico", "image/x-icon"},              {"txt", "text/plain; charset=utf-8"},
      {"woff", "font/woff"},                {"woff2", "font/woff2"},
  };
  return types;
}

static std::string mimeFor(const std::string& path) {
  size_t dot = path.rfind('.');
  if (dot == std::string::npos) return "application/octet-stream";
  std::string ext = path.substr(dot + 1);
  for (char& c : ext) c = (char)tolower((unsigned char)c);
  auto it = mimeTypes().find(ext);
  return it == mimeTypes().end() ? "application/octet-stream" : it->second;
}

// Only serves plain relative paths inside g_webRoot.
// ponytail: no percent-decoding, so "%" in a filename 404s — add it if such files ever appear.
static bool safeRelativePath(const std::string& path) {
  if (path.empty() || path[0] != '/') return false;
  if (path.find("..") != std::string::npos) return false;
  if (path.find('%') != std::string::npos) return false;
  if (path.find('\\') != std::string::npos) return false;
  if (path.find(':') != std::string::npos) return false;
  return true;
}

static bool serveStatic(const std::string& path, Response& res) {
  if (!safeRelativePath(path)) {
    res.code = 404; res.status = "Not Found"; res.body = errorJson("Not found");
    return true;
  }
  std::string rel = path.substr(1);
  if (rel.empty() || rel.back() == '/') rel += "index.html";

  std::ifstream file(g_webRoot + "/" + rel, std::ios::binary);
  if (!file) {
    res.code = 404; res.status = "Not Found"; res.body = errorJson("Not found");
    return true;
  }
  std::string data((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
  res.code = 200; res.status = "OK"; res.contentType = mimeFor(rel); res.body = std::move(data);
  return true;
}

// --------------------------------------------------------------- routes -----

static Response badRequest(const std::string& why) {
  Response res; res.code = 400; res.status = "Bad Request"; res.body = errorJson(why); return res;
}

static bool routeApi(const Request& req, Response& res, std::string& note) {
  const std::string& p = req.path;
  const std::string& m = req.method;
  const bool isApi = p == "/reports" || p.rfind("/reports/", 0) == 0 || p.rfind("/admin/", 0) == 0;
  if (!isApi) return false;
  note = "api";

  if (m == "OPTIONS") {
    res.code = 204; res.status = "No Content";
    return true;
  }

  // POST /reports
  if (p == "/reports" && m == "POST") {
    std::string type, title, category, color, location, date, time, contact, detail, description;
    jsonField(req.body, "type", type);
    jsonField(req.body, "title", title);
    jsonField(req.body, "category", category);
    jsonField(req.body, "color", color);
    jsonField(req.body, "location", location);
    jsonField(req.body, "date", date);
    jsonField(req.body, "time", time);
    jsonField(req.body, "contact", contact);
    jsonField(req.body, "contactDetail", detail);
    jsonField(req.body, "description", description);

    if (type != "lost" && type != "found") { res = badRequest("type must be \"lost\" or \"found\""); return true; }
    if (title.empty()) { res = badRequest("title is required"); return true; }
    if (category.empty()) { res = badRequest("category is required"); return true; }
    if (color.size() > 50 || location.size() > 200 || date.size() > 32 || time.size() > 32 ||
        contact.size() > 100 || detail.size() > 200 || description.size() > 2000 || title.size() > 200) {
      res = badRequest("field too long"); return true;
    }

    sqlite3_stmt* st = nullptr;
    const char* sql =
        "INSERT INTO reports (type, title, category, color, location, date, time, contact, contactDetail, description) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)";
    if (sqlite3_prepare_v2(g_db, sql, -1, &st, nullptr) != SQLITE_OK) {
      res.code = 500; res.status = "Internal Server Error"; res.body = errorJson("database error");
      return true;
    }
    sqlite3_bind_text(st, 1, type.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, 2, title.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, 3, category.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, 4, color.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, 5, location.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, 6, date.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, 7, time.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, 8, contact.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, 9, detail.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_text(st, 10, description.c_str(), -1, SQLITE_TRANSIENT);
    bool ok = sqlite3_step(st) == SQLITE_DONE;
    sqlite3_finalize(st);
    if (!ok) {
      res.code = 500; res.status = "Internal Server Error"; res.body = errorJson("could not save report");
      return true;
    }
    res.code = 201; res.status = "Created";
    res.body = "{\"id\":" + std::to_string(sqlite3_last_insert_rowid(g_db)) + "}";
    return true;
  }

  // GET /reports — contactDetail only comes back to a logged-in coordinator
  if (p == "/reports" && m == "GET") {
    bool coordinator = sessionValid(bearerToken(req));
    std::string sql = std::string("SELECT ") + kReportColumns + " FROM reports ORDER BY id ASC";
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(g_db, sql.c_str(), -1, &st, nullptr) != SQLITE_OK) {
      res.code = 500; res.status = "Internal Server Error"; res.body = errorJson("database error");
      return true;
    }
    std::string out = "[";
    bool first = true;
    while (sqlite3_step(st) == SQLITE_ROW) {
      if (!first) out += ",";
      first = false;
      out += reportJson(st, coordinator);
    }
    sqlite3_finalize(st);
    out += "]";
    res.body = std::move(out);
    return true;
  }

  // POST /admin/login
  if (p == "/admin/login" && m == "POST") {
    std::string username, password;
    jsonField(req.body, "username", username);
    jsonField(req.body, "password", password);
    if (!constantTimeEquals(username, g_adminUser) || !constantTimeEquals(password, g_adminPass)) {
      res.code = 401; res.status = "Unauthorized"; res.body = errorJson("invalid credentials");
      return true;
    }
    std::string token = newToken();
    long long expiresAt = (long long)time(nullptr) + kSessionSeconds;
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(g_db, "INSERT INTO sessions (token, expiresAt) VALUES (?, ?)", -1, &st, nullptr) != SQLITE_OK) {
      res.code = 500; res.status = "Internal Server Error"; res.body = errorJson("database error");
      return true;
    }
    sqlite3_bind_text(st, 1, token.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(st, 2, expiresAt);
    bool ok = sqlite3_step(st) == SQLITE_DONE;
    sqlite3_finalize(st);
    if (!ok) {
      res.code = 500; res.status = "Internal Server Error"; res.body = errorJson("could not start session");
      return true;
    }
    purgeExpired();
    res.body = "{\"token\":\"" + token + "\",\"expiresIn\":" + std::to_string(kSessionSeconds) + "}";
    return true;
  }

  // POST /admin/change-password
  if (p == "/admin/change-password" && m == "POST") {
    std::string username, oldPassword, newPassword;
    jsonField(req.body, "username", username);
    jsonField(req.body, "oldPassword", oldPassword);
    jsonField(req.body, "newPassword", newPassword);
    if (username.empty()) username = g_adminUser;
    if (!constantTimeEquals(username, g_adminUser) || !constantTimeEquals(oldPassword, g_adminPass)) {
      res.code = 401; res.status = "Unauthorized"; res.body = errorJson("invalid username or old password");
      return true;
    }
    if (newPassword.size() < 4) {
      res = badRequest("new password must be at least 4 characters");
      return true;
    }
    g_adminPass = newPassword;
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(g_db, "INSERT OR REPLACE INTO settings (key, val) VALUES ('admin_password', ?)", -1, &st, nullptr) == SQLITE_OK) {
      sqlite3_bind_text(st, 1, newPassword.c_str(), -1, SQLITE_TRANSIENT);
      sqlite3_step(st);
      sqlite3_finalize(st);
    }
    res.body = "{\"message\":\"Password updated successfully\"}";
    return true;
  }

  // PATCH /admin/reports/:id
  if (p.rfind("/admin/reports/", 0) == 0 && m == "PATCH") {
    if (!sessionValid(bearerToken(req))) {
      res.code = 401; res.status = "Unauthorized"; res.body = errorJson("unauthorized");
      return true;
    }
    std::string idText = p.substr(strlen("/admin/reports/"));
    if (idText.empty() || idText.find_first_not_of("0123456789") != std::string::npos) {
      res = badRequest("report id must be a number"); return true;
    }
    std::string status;
    if (!jsonField(req.body, "status", status) || !validStatus(status)) {
      res = badRequest("status must be Open, Possible Match, Claimed or Returned"); return true;
    }
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(g_db, "UPDATE reports SET status = ? WHERE id = ?", -1, &st, nullptr) != SQLITE_OK) {
      res.code = 500; res.status = "Internal Server Error"; res.body = errorJson("database error");
      return true;
    }
    sqlite3_bind_text(st, 1, status.c_str(), -1, SQLITE_TRANSIENT);
    sqlite3_bind_int64(st, 2, (sqlite3_int64)strtoll(idText.c_str(), nullptr, 10));
    bool ok = sqlite3_step(st) == SQLITE_DONE;
    sqlite3_finalize(st);
    if (!ok) {
      res.code = 500; res.status = "Internal Server Error"; res.body = errorJson("could not update report");
      return true;
    }
    if (sqlite3_changes(g_db) == 0) {
      res.code = 404; res.status = "Not Found"; res.body = errorJson("no report with that id");
      return true;
    }
    res.body = "{\"message\":\"Report updated\"}";
    return true;
  }

  res.code = 404; res.status = "Not Found"; res.body = errorJson("Not found");
  return true;
}

// ------------------------------------------------------------ connection ----

// Reads and discards whatever a client is still uploading, so it can read our rejection
// instead of getting a connection reset. Bounded, so a huge upload cannot pin the thread.
static void drainClient(SOCKET client) {
  char sink[8192];
  size_t budget = 1024 * 1024;
  while (budget > 0) {
    int got = recv(client, sink, sizeof sink, 0);
    if (got <= 0) return;
    budget -= (size_t)got;
  }
}

static void handleClient(SOCKET client) {
#ifdef _WIN32
  DWORD timeout = 10000;   // a stalled client must not hold the thread forever
  setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, (const char*)&timeout, sizeof timeout);
  setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, (const char*)&timeout, sizeof timeout);
#else
  struct timeval timeout{};
  timeout.tv_sec = 10;
  setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof timeout);
  setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof timeout);
#endif

  std::string raw;
  char buffer[8192];
  size_t headerEnd = std::string::npos;
  Request req;
  Response res;
  bool parsed = false;
  bool failed = false;      // a Response describing why the request was rejected is ready

  while (true) {
    if (parsed && req.body.size() >= req.declaredLength) break;   // whole request in hand
    int got = recv(client, buffer, sizeof buffer, 0);
    if (got <= 0) break;                                          // client vanished / timed out
    raw.append(buffer, (size_t)got);

    if (!parsed) {
      if (headerEnd == std::string::npos) {
        headerEnd = raw.find("\r\n\r\n");
        if (headerEnd == std::string::npos) {
          if (raw.size() > kMaxHeaderBytes) {
            res.code = 431; res.status = "Request Header Fields Too Large"; res.body = errorJson("headers too large");
            failed = true;
            break;
          }
          continue;
        }
      }
      if (!parseRequest(raw, headerEnd, req)) {
        res.code = 400; res.status = "Bad Request"; res.body = errorJson("malformed request");
        failed = true;
        break;
      }
      parsed = true;
      if (req.declaredLength > kMaxBodyBytes) {
        res.code = 413; res.status = "Payload Too Large"; res.body = errorJson("body too large");
        failed = true;
        break;
      }
    }
    req.body = raw.substr(headerEnd + 4);
  }

  bool complete = parsed && req.body.size() >= req.declaredLength;
  if (complete) {
    std::string note;
    if (!routeApi(req, res, note)) serveStatic(req.path, res);
  }
  if (complete || failed) {
    sendResponse(client, res);
    if (failed) drainClient(client);
    fprintf(stdout, "%s %s -> %d\n", req.method.c_str(), req.path.c_str(), res.code);
    fflush(stdout);
  }
  shutdown(client, SD_SEND);
  closesocket(client);
}

// ------------------------------------------------------------------ main ----

static std::string envOr(const char* name, const char* fallback) {
  const char* v = getenv(name);
  return (v && *v) ? std::string(v) : std::string(fallback);
}

int main() {
  int port = atoi(envOr("PORT", "3000").c_str());
  std::string dbPath = envOr("FINDIT_DB", "findit.db");
  g_webRoot = envOr("FINDIT_WEB", "../../repo");
  g_adminUser = envOr("ADMIN_USERNAME", "admin");
  g_adminPass = envOr("ADMIN_PASSWORD", "password");

  if (sqlite3_open(dbPath.c_str(), &g_db) != SQLITE_OK) {
    fprintf(stderr, "findit: cannot open database %s\n", dbPath.c_str());
    return 1;
  }
  sqlite3_busy_timeout(g_db, 3000);
  dbExecOrDie(
      "CREATE TABLE IF NOT EXISTS reports ("
      " id INTEGER PRIMARY KEY AUTOINCREMENT,"
      " type TEXT NOT NULL,"
      " title TEXT NOT NULL,"
      " category TEXT NOT NULL,"
      " color TEXT,"
      " location TEXT,"
      " date TEXT,"
      " time TEXT,"
      " contact TEXT,"
      " contactDetail TEXT,"
      " description TEXT,"
      " status TEXT NOT NULL DEFAULT 'Open',"
      " createdAt TEXT NOT NULL DEFAULT (datetime('now')));"
      "CREATE TABLE IF NOT EXISTS sessions ("
      " token TEXT PRIMARY KEY,"
      " expiresAt INTEGER NOT NULL);"
      "CREATE TABLE IF NOT EXISTS settings ("
      " key TEXT PRIMARY KEY,"
      " val TEXT);"
      "CREATE INDEX IF NOT EXISTS reports_createdAt ON reports(createdAt);");

  {
    sqlite3_stmt* st = nullptr;
    if (sqlite3_prepare_v2(g_db, "SELECT val FROM settings WHERE key = 'admin_password'", -1, &st, nullptr) == SQLITE_OK) {
      if (sqlite3_step(st) == SQLITE_ROW) {
        const unsigned char* val = sqlite3_column_text(st, 0);
        if (val) g_adminPass = reinterpret_cast<const char*>(val);
      }
      sqlite3_finalize(st);
    }
  }

  int purged = purgeExpired();
  if (purged > 0) printf("findit: retention removed %d report(s) older than 7 days\n", purged);

  // Retention worker. The policy says daily; purging hourly is idempotent and keeps the
  // window accurate to the hour.
  std::thread([] {
    for (;;) {
      std::this_thread::sleep_for(std::chrono::seconds(kPurgeIntervalSec));
      int removed = purgeExpired();
      if (removed > 0) {
        printf("findit: retention removed %d report(s) older than 7 days\n", removed);
        fflush(stdout);
      }
    }
  }).detach();

#ifdef _WIN32
  WSADATA wsa;
  if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) {
    fprintf(stderr, "findit: winsock init failed\n");
    return 1;
  }
#endif
  SOCKET server = socket(AF_INET, SOCK_STREAM, 0);
  if (server == INVALID_SOCKET) {
    fprintf(stderr, "findit: socket() failed\n");
    return 1;
  }
  int yes = 1;
  setsockopt(server, SOL_SOCKET, SO_REUSEADDR, (const char*)&yes, sizeof yes);

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = INADDR_ANY;
  addr.sin_port = htons((u_short)port);
  if (bind(server, (sockaddr*)&addr, sizeof addr) == SOCKET_ERROR) {
    fprintf(stderr, "findit: bind failed on port %d (%d)\n", port, WSAGetLastError());
    return 1;
  }
  if (listen(server, 64) == SOCKET_ERROR) {
    fprintf(stderr, "findit: listen failed (%d)\n", WSAGetLastError());
    return 1;
  }

  sockaddr_in bound{};
#ifdef _WIN32
  int boundLen = sizeof bound;
  getsockname(server, (sockaddr*)&bound, &boundLen);
#else
  socklen_t boundLen = sizeof bound;
  getsockname(server, (sockaddr*)&bound, &boundLen);
#endif
  int actualPort = ntohs(bound.sin_port);

  printf("findit: listening on port=%d db=%s web=%s\n", actualPort, dbPath.c_str(), g_webRoot.c_str());
  if (g_adminPass == "password") {
    printf("findit: WARNING using the default admin password — set ADMIN_PASSWORD before sharing this server\n");
  }
  fflush(stdout);

  for (;;) {
    SOCKET client = accept(server, nullptr, nullptr);
    if (client == INVALID_SOCKET) continue;
    std::thread(handleClient, client).detach();
  }
}
