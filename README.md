# FindIt

A campus lost-and-found application for the SSTC campus. Students can publish a lost or found report, browse the campus board, and submit a private claim. A coordinator verifies ownership and records the handover.

[Live site](https://sstcfindit.me/) · [Run locally](#run-locally) · [MIT License](LICENSE)

## How it works

1. **Report.** A student publishes an item description and location. Their contact details and optional ownership clue are available to the coordinator.
2. **Find and claim.** Students can filter the public board or review suggested lost and found pairs. The matcher explains each suggestion using details such as the item description, category, and location. A claimant submits ownership evidence privately and receives a reference.
3. **Return.** The coordinator reviews the claim, records how ownership was verified, and closes the found report and any linked lost report after handover.

## Run locally

Install Python 3.10 or later. Clone the repository and run the demo from its root.

```sh
git clone https://github.com/tomorrowlord03/FindIt.git
cd FindIt
python demo.py
```

The demo opens in your browser, seeds a temporary SQLite database with fictional reports, and prints the coordinator username and a temporary password in your terminal. Press **Ctrl+C** to stop the demo and remove its database. Use `python3` if that is how Python is installed on your system, or pass `--no-browser` to print the URL without launching a browser.

## Architecture

| Component | Implementation |
| --- | --- |
| Interface | [HTML](index.html), [CSS](styles.css), and [vanilla JavaScript](app.js) |
| Application server | [Python standard library](server.py) |
| Storage | SQLite for reports, claims, receipts, and handover history |
| Match suggestions | [Client-side JavaScript](algorithms.js) |
| Hosting | Amazon EC2 with nginx and HTTPS |

Public report responses exclude contact details and ownership evidence. The live deployment uses a seven-day retention period for public listings and private report data.

## Development and tests

For a persistent local instance, set a unique `FINDIT_PASSWORD` of at least 12 characters in your environment and run `python server.py`. The server listens on `127.0.0.1:5500` by default. Set `FINDIT_DB` to a private database path outside the repository to choose where records are stored.

Use Node.js for the matching tests and Python for the server tests.

```sh
npm test
python -m unittest discover -s tests -v
```

See the [deployment runbook](deploy/RELEASE.md) for environment settings, migration, and rollback. The [original project synopsis](SYNOPSIS.md) and [legacy C++ server](server/cpp/) document the earlier implementation.

## License

FindIt is available under the [MIT License](LICENSE).
