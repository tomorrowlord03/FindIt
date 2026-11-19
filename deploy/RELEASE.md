# FindIt Python cutover

Run on the EC2 host from the reviewed release checkout using Bash. The new service uses `127.0.0.1:3000` behind the existing nginx site. Keep the original C++ service and database in place for rollback.

## Before you start

### Verified production facts (2026-11-19, read-only)

- **Host & Environment**: EC2 instance `i-04d331ab6843f8f2d` in `eu-north-1`, running Ubuntu 24.04.4 LTS and Python 3.12.3.
- **Service state**: systemd unit `findit` enabled and active on port 3000.
- **C++ build & DB**: C++ binary built from commit `367f661`. Database at `/home/ubuntu/FindIt/server/cpp/findit.db` (file mode `0644`, currently 0 reports, contains a stale `settings.admin_password` row holding an old plaintext password).
- **Reverse proxy**: Nginx managed by Certbot serves `sstcfindit.me` and `www.sstcfindit.me` on port 443, proxying to `127.0.0.1:3000` with `proxy_set_header X-Real-IP $remote_addr;`.
- **EBS storage & baseline**: Baseline snapshot `snap-05fd76b724b0ac3e5` taken before any change on volume `vol-0b789e4e2adab794f`.
- **Host access**: The instance has no SSM agent and no EC2 key pair configured. Host access is strictly via EC2 Instance Connect (`aws ec2-instance-connect send-ssh-public-key ... --instance-os-user ubuntu`, then ssh within 60 s). No credentials are kept in this document.

### Host connection

Connect via EC2 Instance Connect by pushing a short-lived SSH public key (valid for 60 seconds) and opening an SSH session:

```sh
aws ec2-instance-connect send-ssh-public-key \
  --region eu-north-1 \
  --instance-id i-04d331ab6843f8f2d \
  --instance-os-user ubuntu \
  --ssh-public-key file://~/.ssh/id_rsa.pub

ssh -i ~/.ssh/id_rsa ubuntu@<instance-public-ip-or-dns>
```

### Fresh EBS snapshot

Right before cutover, take a fresh EBS snapshot of the volume:

```sh
aws ec2 create-snapshot \
  --region eu-north-1 \
  --volume-id vol-0b789e4e2adab794f \
  --description "findit-cutover-$(date +%Y%m%d%H%M%S)"
```

## Read-only preflight

```sh
old_db=/home/ubuntu/FindIt/server/cpp/findit.db
python3 --version
sqlite3 --version
sudo systemctl show findit -p ActiveState -p WorkingDirectory -p UnitFileState
sudo ss -ltnp '( sport = :3000 or sport = :3100 )'
sudo stat "$old_db"
sudo df -h /var/lib /var/backups
sudo nginx -t
sudo nginx -T 2>&1 | grep -E 'server_name .*sstcfindit\.me|proxy_pass .*127\.0\.0\.1:3000|proxy_set_header X-Real-IP'
```

Confirm Python 3.10 or later, `findit` active on port 3000, port 3100 free, and disk space for two backups and two migrated copies. Verify that the nginx location serving this site forwards requests to port 3000 and overwrites `X-Real-IP` using `$remote_addr`. Resolve any preflight mismatch before scheduling cutover.

## Stage and smoke-test

```sh
id findit >/dev/null 2>&1 || sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin findit
sudo install -d -m 0755 /opt/findit
sudo install -m 0644 server.py migrate_cpp.py index.html app.js algorithms.js styles.css /opt/findit/
sudo install -d -m 0700 /etc/findit /var/backups/findit
sudo install -d -m 0700 -o findit -g findit /var/lib/findit
sudo install -m 0644 deploy/findit-python.service /etc/systemd/system/findit-python.service
sudo test -e /etc/findit/findit.env || sudo install -m 0600 deploy/findit.env.example /etc/findit/findit.env
sudoedit /etc/findit/findit.env
sudo chmod 0600 /etc/findit/findit.env
sudo systemd-analyze verify /etc/systemd/system/findit-python.service
sudo systemctl daemon-reload
```

Replace the placeholder with a unique bootstrap password of at least 12 characters. Sign in as `admin`. A password changed through the coordinator form is stored as a salted PBKDF2-SHA256 hash in the Python database and takes precedence over `FINDIT_PASSWORD` at startup. Keep the database to retain that password. The Python service uses a seven-day retention period for reports and private records. The migration copies all reports and leaves legacy sessions and settings behind.

The Python server purges reports older than 7 days at first start (C++ `createdAt` is SQLite `datetime('now')`, i.e. UTC, matching `migrate_cpp.py`), so migrated rows past 7 days disappear by design.

Take a private SQLite backup while C++ is running. Use a fresh path for each backup and migration. Run the smoke test inside an enclosed subshell that halts on any error:

```sh
sudo bash -euo pipefail <<'EOF'
old_db=/home/ubuntu/FindIt/server/cpp/findit.db
smoke_backup=$(sudo mktemp -d /var/backups/findit/smoke.XXXXXX)
smoke_data=$(sudo mktemp -d /var/lib/findit/smoke.XXXXXX)
sudo sh -c 'umask 077; exec sqlite3 -readonly "$1" ".backup $2/findit.db"' sh "$old_db" "$smoke_backup"
sudo sqlite3 -readonly "$smoke_backup/findit.db" 'PRAGMA quick_check;'
sudo python3 /opt/findit/migrate_cpp.py --source "$smoke_backup/findit.db" --target "$smoke_data/reports.sqlite3" --dry-run
sudo python3 /opt/findit/migrate_cpp.py --source "$smoke_backup/findit.db" --target "$smoke_data/reports.sqlite3"
sudo chown findit:findit "$smoke_data" "$smoke_data/reports.sqlite3"
sudo systemd-run --unit=findit-python-smoke --collect --property=User=findit \
  --property=EnvironmentFile=/etc/findit/findit.env \
  --setenv=FINDIT_DB="$smoke_data/reports.sqlite3" --setenv=FINDIT_PORT=3100 \
  --setenv=FINDIT_USERNAME=admin --setenv=FINDIT_PRIVATE_DAYS=7 \
  /usr/bin/python3 /opt/findit/server.py
curl --retry 5 --retry-connrefused -fsS http://127.0.0.1:3100/api/config >/dev/null
curl -fsS http://127.0.0.1:3100/api/reports | python3 -c 'import json, sys; rows = json.load(sys.stdin)["reports"]; assert all(not {"contact", "contactDetail", "privateClue"}.intersection(row) for row in rows); print(len(rows), "public reports")'
test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3100/api/admin)" = 401
sudo systemctl stop findit-python-smoke
sudo rm -rf "$smoke_backup" "$smoke_data"
EOF
```

Require `quick_check` to return `ok`, matching source and target counts in both migration runs, and passing HTTP checks. After the smoke test passes, the smoke directories are removed. Backups and smoke databases contain private contact data. Keep them in the restricted directories and apply the site's retention policy.

## Cut over

Use a maintenance window. Stop C++ before taking the final SQLite backup so it cannot accept writes after the migration snapshot. Immediately restrict permissions on the legacy C++ database (`sudo chmod 0600`) to protect the stale plaintext password. Stop at any failed command and follow the rollback steps instead of starting with a partial database. Run the cutover block as an enclosed subshell that halts on any error:

```sh
sudo bash -euo pipefail <<'EOF'
old_db=/home/ubuntu/FindIt/server/cpp/findit.db
target=/var/lib/findit/reports.sqlite3
sudo test ! -e "$target"
final_backup=$(sudo mktemp -d /var/backups/findit/cutover.XXXXXX)
sudo systemctl stop findit
sudo chmod 0600 "$old_db"
sudo sh -c 'umask 077; exec sqlite3 -readonly "$1" ".backup $2/findit.db"' sh "$old_db" "$final_backup"
sudo sqlite3 -readonly "$final_backup/findit.db" 'PRAGMA quick_check;'
sudo python3 /opt/findit/migrate_cpp.py --source "$final_backup/findit.db" --target "$target"
sudo chown findit:findit "$target"
sudo systemctl start findit-python
sudo systemctl is-active findit-python
curl --retry 5 --retry-connrefused -fsS http://127.0.0.1:3000/api/config >/dev/null
curl -fsS https://sstcfindit.me/api/reports | python3 -c 'import json, sys; assert all(not {"contact", "contactDetail", "privateClue"}.intersection(row) for row in json.load(sys.stdin)["reports"])'
test "$(curl -sS -o /dev/null -w '%{http_code}' https://sstcfindit.me/api/admin)" = 401
EOF
```

Through the HTTPS site, sign in as `admin`, verify the coordinator queue loads and existing report contacts are visible, then lock the view. Confirm the board loads without signing in. Once verified, check boot enablement and switch which unit starts at boot:

```sh
systemctl is-enabled findit findit-python
sudo systemctl disable findit
sudo systemctl enable findit-python
systemctl is-enabled findit findit-python
```

Before switching, confirm that `findit` is enabled and `findit-python` is disabled. After switching, require that exactly one unit is enabled (`findit` disabled, `findit-python` enabled).

## Roll back

```sh
sudo systemctl stop findit-python
sudo systemctl start findit
sudo systemctl is-active findit
curl -fsS -o /dev/null https://sstcfindit.me/reports
```

If you switched the boot units, revert them and verify with `systemctl is-enabled`:

```sh
sudo systemctl disable findit-python
sudo systemctl enable findit
systemctl is-enabled findit findit-python
```

Require that `findit` is enabled and `findit-python` is disabled (exactly one unit enabled). If preflight showed that `findit` was disabled originally, run `sudo systemctl disable findit`.

C++ resumes from its original database and credentials. Keep the Python database for recovery of any reports, handovers, or password changes made during the cutover.

## After the rollback window (7 days)

Once the 7-day rollback window has elapsed and the Python service is stable:

1. Delete all cutover and smoke backups under `/var/backups/findit/`.
2. Delete the legacy C++ database at `/home/ubuntu/FindIt/server/cpp/findit.db` along with its stale plaintext `settings.admin_password` row (if not already restricted via `sudo chmod 0600` at cutover).

Backups hold private contact data under the same 7-day retention promise. Do not retain them past the rollback period.

```sh
sudo rm -rf /var/backups/findit/*
sudo rm -f /home/ubuntu/FindIt/server/cpp/findit.db
```
