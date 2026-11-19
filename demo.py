"""Run a private, disposable campus lost-and-found demonstration."""

import argparse
from datetime import date
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
from tempfile import TemporaryDirectory
from urllib.request import Request, urlopen
import webbrowser


def seed(url):
    for kind, title in (("lost", "Blue insulated bottle"), ("found", "Blue water bottle")):
        report = dict(type=kind, title=title, color="Blue", location="Library",
                      category="Other", date=date.today().isoformat(),
                      description="Insulated stainless steel water bottle.",
                      contact="Demo student", contactDetail="demo@example.invalid",
                      privateClue="A small crescent engraved underneath.",
                      requestId=f"demo-bottle-{kind}")
        request = Request(url + "/api/reports", data=json.dumps(report).encode(),
                          headers={"Content-Type": "application/json", "Origin": url})
        with urlopen(request, timeout=5) as response:
            json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    with TemporaryDirectory(prefix="findit-demo-") as folder:
        password = secrets.token_urlsafe(16)
        env = {k: v for k, v in os.environ.items() if not k.startswith("FINDIT_")}
        env.update(FINDIT_DB=str(Path(folder) / "demo.sqlite3"), FINDIT_PORT="0",
                   FINDIT_PASSWORD=password, FINDIT_DESK="Demo pickup desk",
                   FINDIT_CONTACT="demo@example.invalid", FINDIT_HOURS="By appointment (demo)")
        process = subprocess.Popen([sys.executable, str(Path(__file__).with_name("server.py"))],
                                   env=env, stdout=subprocess.PIPE, text=True)
        try:
            line = process.stdout.readline().strip()
            if not line.startswith("FindIt ready at http://127.0.0.1:"):
                raise SystemExit("The local demo could not start.")
            url = line.removeprefix("FindIt ready at ")
            seed(url)
            print(f"Local demo: {url}\nCoordinator username: coordinator\n"
                  f"Temporary demo password: {password}\nPress Ctrl+C to end.", flush=True)
            if not args.no_browser:
                webbrowser.open(url)
            process.wait()
        except KeyboardInterrupt:
            pass
        finally:
            process.terminate()
            process.wait()
            process.stdout.close()


if __name__ == "__main__":
    main()
