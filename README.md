# FindIt | Campus Lost & Found System

FindIt is a full-stack campus lost-and-found portal designed for privacy, explainable matching, and fast local deployment.

It features a high-performance **C++17 & SQLite REST API backend** paired with a clean, dependency-free **vanilla HTML/CSS/JavaScript single-page frontend**.

---

## Key Features

1. **Item Reporting & Public Board**:
   - Students can publish lost or found item reports with categorization, location, color, timestamp, and contact information.
   - Public board allows filtering by keywords, item category, and lifecycle status (`Open`, `Possible Match`, `Claimed`, `Returned`).

2. **Explainable Matching Engine**:
   - Compares lost and found reports using weighted heuristic attributes (category: 25, colour: 20, location: 20, date proximity: 15, description token overlap: 20).
   - Surfaces matches with a transparent breakdown explaining *why* an item was suggested.

3. **Privacy-Preserving Coordinator Dashboard**:
   - Student contact details (`contactDetail`) are strictly redacted from anonymous public listings.
   - Campus coordinators authenticate via `/admin/login` using constant-time verified credentials and a secure session token.
   - Authenticated coordinators can view private contact details and update report lifecycle status (`Open` → `Claimed` → `Returned`).
   - Includes **Change Password / Password Reset** functionality (`POST /admin/change-password`) allowing administrators to update their password on the basis of their old password, persisted directly in SQLite.

4. **Automated 7-Day Data Retention**:
   - In accordance with campus data privacy guidelines, reports older than 7 days are automatically purged both upon server startup and via an hourly background worker.

---

## Architecture & Tech Stack

- **Backend**: C++17 REST API (`server/cpp/main.cpp`) utilizing native Winsock2 networking and embedded SQLite3 (`findit.db`). Serves both API endpoints and the static frontend on port 3000.
- **Frontend**: Vanilla JavaScript (`app.js`, `algorithms.js`), semantic HTML5 (`index.html`), and CSS3 (`styles.css`). Zero external JavaScript framework dependencies.
- **Database**: SQLite3 relational database with indexed timestamps for efficient retention purges.

### REST API Endpoints

| Method | Endpoint | Description | Auth Required |
|---|---|---|---|
| `POST` | `/reports` | Submit a new lost/found report | No |
| `GET` | `/reports` | Retrieve active reports (contactDetail hidden unless authenticated) | Optional (Bearer Token) |
| `POST` | `/admin/login` | Authenticate coordinator (`username`, `password`) | No |
| `POST` | `/admin/change-password` | Update admin password (`username`, `oldPassword`, `newPassword`) | No (Validates Old Password) |
| `PATCH` | `/admin/reports/:id` | Update report status (`Open`, `Possible Match`, `Claimed`, `Returned`) | Yes (Bearer Token) |

---

## Getting Started

### 1. Build & Run the C++ Backend Server

#### Prerequisites
- A C++17 compiler (e.g. GCC / MinGW `g++`)
- SQLite3 amalgamation (or run `./build.sh` on Unix/Git Bash)

#### Building on Windows (PowerShell / MinGW)
```powershell
# Compile the server:
g++ -std=c++17 -O2 -o server/cpp/build/findit-server.exe server/cpp/main.cpp server/cpp/build/sqlite3.o -Iserver/cpp/build -lws2_32 -lbcrypt -static

# Run the server:
& server/cpp/build/findit-server.exe
```

#### Building on Linux / macOS
```bash
cd server/cpp
bash build.sh
./build/findit-server
```

The server listens on **`http://127.0.0.1:3000/`** and automatically serves the frontend web app.

### 2. Default Coordinator Credentials
- **Username**: `admin`
- **Password**: `password` (changeable in the coordinator portal via "Change password")

---

## Running Automated Tests

### Frontend Matching Tests
```bash
node algorithms.test.mjs
```

### Backend C++ / SQLite Integration Tests
With the C++ server built:
```bash
cd server/cpp
node test_api.mjs
```
Runs 25 comprehensive automated checks covering CORS, input validation, authentication, password updates, report updates, static serving, and 7-day data retention.

---

## Project Structure

```
├── algorithms.js              # Explainable matching heuristic & text similarity
├── algorithms.test.mjs        # Frontend unit tests
├── app.js                     # SPA controllers, API client, coordinator workflow
├── index.html                 # Semantic single-page application interface
├── styles.css                 # Clean, responsive styling
├── FindIt_Project_Synopsis.docx # Updated official project synopsis document
├── SYNOPSIS.md                # Complete project synopsis in Markdown
├── server/
│   ├── cpp/
│   │   ├── main.cpp           # C++17 Winsock REST API & SQLite server
│   │   ├── build.sh           # Unix/Bash build script
│   │   └── test_api.mjs       # Backend integration test suite (25 checks)
│   ├── index.js               # Reference Node.js prototype server
│   └── package.json           # Node dependencies for prototype and test runner
```
