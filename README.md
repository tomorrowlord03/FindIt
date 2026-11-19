# FindIt

FindIt is the campus lost-and-found system for SSTC. Students report lost or found items on a public board, while personal contact details and private verification clues remain hidden from public view. When an owner recognises an item, they submit a private claim with an ownership clue. A campus coordinator reviews the evidence, confirms the handover, and closes linked lost and found reports together.

The staging backend is built entirely with Python 3.10+ standard library modules and SQLite. It requires no third-party package installations.

## Run the pitch demo (Windows)

From the repository folder, start the automated demo:

```powershell
python demo.py
```

Or using the Python launcher:

```powershell
py demo.py
```

On macOS or Linux:

```bash
python3 demo.py
```

The script:
1. Creates a temporary, disposable SQLite database pre-populated with sample reports.
2. Starts the server on an available local port and prints the local URL, the coordinator username (`coordinator`), and a randomly generated temporary password.
3. Automatically opens the demo in your default browser.

To start without opening the browser automatically:

```powershell
python demo.py --no-browser
```

Press `Ctrl+C` in the terminal to stop the server and delete the temporary database.

## Run a persistent local server

For persistent local operation, run `server.py` directly. Configuration is handled through environment variables:

| Variable | Required / Default | Description |
|---|---|---|
| `FINDIT_PASSWORD` | **Required** (min 12 chars) | Password for coordinator sign-in. |
| `FINDIT_DB` | `~/.findit/reports.sqlite3` | SQLite database file path (must be outside the repository folder). |
| `FINDIT_HOST` | `127.0.0.1` | Host address to bind. |
| `FINDIT_PORT` | `5500` | Port to listen on. |
| `FINDIT_USERNAME` | `coordinator` | Username for coordinator sign-in. |
| `FINDIT_PRIVATE_DAYS` | `30` (min 7) | Days to retain private report records and history before purging. |
| `FINDIT_ORIGIN` | Unset (inferred from `Host`) | Expected HTTP Origin for CSRF enforcement. |
| `FINDIT_DESK` | `""` (empty string) | Pickup desk location displayed across the UI. |
| `FINDIT_HOURS` | `""` (empty string) | Pickup hours displayed across the UI. |
| `FINDIT_CONTACT` | `""` (empty string) | Coordinator contact details displayed across the UI. |

### PowerShell example (Windows)

```powershell
$env:FINDIT_PASSWORD = "<choose your own>"; python server.py
```

### Bash example (macOS / Linux)

```bash
export FINDIT_PASSWORD="<choose your own>"; python3 server.py
```

*Note: Choose your own unique password of at least 12 characters. Never put real passwords in the README or source control.*

## Coordinator setup

1. Open the application and navigate to `#admin` (or click **Coordinator** in the top navigation).
2. Sign in using the coordinator username (`coordinator` by default) and the password set in `FINDIT_PASSWORD`.
3. A "Change password" form in the coordinator view is being added. When changed, the password is stored as a salted PBKDF2 hash in the database, and the stored password takes precedence over `FINDIT_PASSWORD` on subsequent server starts.
4. Click **Lock view** to end the session immediately and protect private records.

## Tests

Run the test suites from the repository folder:

- **Matcher algorithm tests**:
  ```bash
  node algorithms.test.mjs
  ```
- **Journey and backup/restore tests**:
  ```bash
  python -m unittest discover -s tests -v
  ```
  *(macOS/Linux: `python3 -m unittest discover -s tests -v`). More test suites are being added.*

## Pitch walkthrough (5 minutes)

Follow these steps with two browser windows using fictional demo data:

1. **Student A reports a found item**:
   - In window 1, go to **Report an item** (`#report`) and choose **I found something**.
   - Public details: Item name "Silver calculator", Category "Electronics", Location "Physics Lab 2", Date (today), Description "Scientific calculator left on a bench".
   - Private details: Name "Student A", Contact "student-a@example.invalid", Private clue "Sticker of a blue rocket on back cover".
   - Submit the form and note the generated report reference (`FI-...`).
2. **Student B searches and files a private claim**:
   - In window 2 (a private window), go to **Browse reports** (`#reports`).
   - Search for "calculator" or "Physics Lab". Open the "Silver calculator" report card and click **This may be mine**.
   - Enter claimant details: Name "Student B", Contact "student-b@example.invalid", and ownership evidence: "Has a blue rocket sticker on the back battery cover".
   - Submit the claim and note the private claim reference (`CL-...`).
3. **Inspect possible matches**:
   - Click **Possible matches** (`#matches`) to see suggested report pairings evaluated by campus keywords, category, and location.
4. **Coordinator confirms handover**:
   - In window 1, go to **Coordinator** (`#admin`) and sign in.
   - In the review queue, locate the pending claim (`CL-...`). Inspect Student B's evidence against Student A's private clue.
   - Under **Review claim**, choose **Confirm item returned**, optionally link a corresponding lost report, provide a verification note, and click **Save decision**.
   - Both reports close and update their status to **Returned**.
5. **Verify privacy and lock view**:
   - Click **Lock view** to log out of the coordinator desk.
   - Check the public **Browse reports** and **Dashboard** views: the item shows as "Returned", but contact details and private clues are never shown on the public board.

## Pickup desk, hours and retention

The demo uses placeholder values:
- Desk: `"Demo pickup desk"`
- Hours: `"By appointment (demo)"`
- Contact: `demo@example.invalid`

SSTC's real desk location, hours, and retention policies are **not confirmed**. They must be confirmed with SSTC administration before setting production values via `FINDIT_DESK`, `FINDIT_HOURS`, and `FINDIT_CONTACT`.

- **Public retention**: Listings appear on the public board for 7 days (`PUBLIC_DAYS`).
- **Private retention**: Full records, claims, and audit history are kept for `FINDIT_PRIVATE_DAYS` (default 30 days, minimum 7 days) before automatic cleanup.

## Production

sstcfindit.me currently runs the older C++ backend; moving to this server is planned through `migrate_cpp.py` and `deploy/RELEASE.md` (being added) and has not happened yet.
