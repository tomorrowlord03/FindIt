// Runnable end-to-end check for the C++/SQLite backend.  Build first, then:  node test_api.mjs
// No test framework and no fixtures: it starts the built server on a throwaway database
// and exercises every endpoint, the auth rules, input validation and the 7-day retention.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, 'build', process.platform === 'win32' ? 'findit-server.exe' : 'findit-server');
const WEB = join(HERE, '..', '..', 'repo');
const PASSWORD = 'secret-123';

if (!existsSync(SERVER)) {
  console.error('build/findit-server is missing — run ./build.sh first');
  process.exit(1);
}

const workDir = mkdtempSync(join(tmpdir(), 'findit-cpp-'));
const dbFile = join(workDir, 'test.db');
const serverEnv = {
  ...process.env,
  PORT: '0',
  FINDIT_DB: dbFile,
  FINDIT_WEB: WEB,
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: PASSWORD,
};

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

function startServer() {
  const proc = spawn(SERVER, [], { cwd: HERE, env: serverEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start within 15s:\n${log}`)), 15000);
    proc.stdout.on('data', (chunk) => {
      log += chunk;
      const port = /port=(\d+)/.exec(log);
      if (port) {
        clearTimeout(timer);
        resolve({ proc, port: Number(port[1]), log: () => log });
      }
    });
    proc.stderr.on('data', (chunk) => { log += chunk; });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}:\n${log}`));
    });
  });
}

async function stopServer(server) {
  if (!server) return;
  const exited = new Promise((resolve) => server.proc.on('exit', resolve));
  server.proc.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
}

const report = {
  type: 'lost',
  title: 'Black wireless earphones',
  category: 'Electronics',
  color: 'Black',
  location: 'Central Library',
  date: '2026-09-12',
  time: '11:30',
  contact: 'Aarav',
  contactDetail: 'aarav@example.com',
  description: 'Small black Bluetooth earphones in a charging case.',
};

let first = null;
let second = null;
try {
  first = await startServer();
  const base = `http://127.0.0.1:${first.port}`;
  const post = (path, body, headers = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const patch = (path, body, headers = {}) =>
    fetch(base + path, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

  let reportId = null;
  let token = null;

  console.log('\nstatic files');
  await check('GET / serves the frontend index.html', async () => {
    const res = await fetch(base + '/');
    const body = await res.text();
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    if (!res.headers.get('content-type').includes('text/html')) throw new Error('wrong content type');
    if (!body.includes('FindIt')) throw new Error('index.html was not served');
  });
  await check('GET /app.js is served as javascript', async () => {
    const res = await fetch(base + '/app.js');
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    if (!res.headers.get('content-type').includes('javascript')) throw new Error('wrong content type');
  });
  await check('path traversal is refused', async () => {
    for (const path of ['/..%2F..%2F.gitignore', '/....//package.json', '/%2e%2e/server/index.js']) {
      const res = await fetch(base + path);
      if (res.status !== 404) throw new Error(`${path} returned ${res.status}, expected 404`);
    }
  });

  console.log('\nPOST /reports');
  await check('valid report is stored and returns its id', async () => {
    const res = await post('/reports', report);
    const body = await res.json();
    if (res.status !== 201) throw new Error(`expected 201, got ${res.status}: ${JSON.stringify(body)}`);
    if (typeof body.id !== 'number') throw new Error('no numeric id returned');
    reportId = body.id;
  });
  await check('bad type is rejected', async () => {
    const res = await post('/reports', { ...report, type: 'stolen' });
    if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
  });
  await check('missing title is rejected', async () => {
    const res = await post('/reports', { ...report, title: '' });
    if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
  });
  await check('oversized body is rejected', async () => {
    const res = await post('/reports', { ...report, description: 'x'.repeat(300 * 1024) });
    if (res.status !== 413) throw new Error(`expected 413, got ${res.status}`);
  });

  console.log('\nGET /reports');
  await check('public listing hides contactDetail', async () => {
    const res = await fetch(base + '/reports');
    const rows = await res.json();
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    if (rows.length !== 1) throw new Error(`expected 1 row, got ${rows.length}`);
    if (rows[0].title !== report.title) throw new Error('wrong row returned');
    if (rows[0].status !== 'Open') throw new Error(`expected status Open, got ${rows[0].status}`);
    if ('contactDetail' in rows[0]) throw new Error('contactDetail leaked to an anonymous caller');
  });

  console.log('\nPOST /admin/login');
  await check('wrong password gets 401', async () => {
    const res = await post('/admin/login', { username: 'admin', password: 'nope' });
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
  });
  await check('right credentials return a token', async () => {
    const res = await post('/admin/login', { username: 'admin', password: PASSWORD });
    const body = await res.json();
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    if (typeof body.token !== 'string' || body.token.length < 32) throw new Error('no token returned');
    token = body.token;
  });
  await check('the coordinator sees contactDetail', async () => {
    const res = await fetch(base + '/reports', { headers: { Authorization: `Bearer ${token}` } });
    const rows = await res.json();
    if (rows[0].contactDetail !== report.contactDetail) throw new Error('contactDetail missing for the coordinator');
  });

  console.log('\nPOST /admin/change-password');
  await check('wrong old password gets 401', async () => {
    const res = await post('/admin/change-password', { username: 'admin', oldPassword: 'wrong', newPassword: 'new-password-123' });
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
  });
  await check('too short new password gets 400', async () => {
    const res = await post('/admin/change-password', { username: 'admin', oldPassword: PASSWORD, newPassword: '12' });
    if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
  });
  await check('valid old password updates the admin password', async () => {
    const res = await post('/admin/change-password', { username: 'admin', oldPassword: PASSWORD, newPassword: 'new-password-123' });
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    const oldLogin = await post('/admin/login', { username: 'admin', password: PASSWORD });
    if (oldLogin.status !== 401) throw new Error('old password still accepted after change');
    const newLogin = await post('/admin/login', { username: 'admin', password: 'new-password-123' });
    if (newLogin.status !== 200) throw new Error('new password rejected');
  });

  console.log('\nPATCH /admin/reports/:id');
  await check('anonymous update gets 401', async () => {
    const res = await patch(`/admin/reports/${reportId}`, { status: 'Claimed' });
    if (res.status !== 401) throw new Error(`expected 401, got ${res.status}`);
  });
  await check('garbage status is rejected', async () => {
    const res = await patch(`/admin/reports/${reportId}`, { status: 'Deleted' }, { Authorization: `Bearer ${token}` });
    if (res.status !== 400) throw new Error(`expected 400, got ${res.status}`);
  });
  await check('unknown id gets 404', async () => {
    const res = await patch('/admin/reports/99999', { status: 'Claimed' }, { Authorization: `Bearer ${token}` });
    if (res.status !== 404) throw new Error(`expected 404, got ${res.status}`);
  });
  await check('status change is persisted', async () => {
    const res = await patch(`/admin/reports/${reportId}`, { status: 'Claimed' }, { Authorization: `Bearer ${token}` });
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
    const rows = await (await fetch(base + '/reports')).json();
    if (rows[0].status !== 'Claimed') throw new Error(`expected Claimed, got ${rows[0].status}`);
  });

  console.log('\nCORS + unknown routes');
  await check('preflight gets CORS headers', async () => {
    const res = await fetch(base + '/reports', { method: 'OPTIONS' });
    if (res.status !== 204) throw new Error(`expected 204, got ${res.status}`);
    if (res.headers.get('access-control-allow-origin') !== '*') throw new Error('missing allow-origin');
  });
  await check('unknown path returns a JSON 404', async () => {
    const res = await fetch(base + '/nope');
    if (res.status !== 404) throw new Error(`expected 404, got ${res.status}`);
    const body = await res.json();
    if (!body.error) throw new Error('expected an error body');
  });

  console.log('\n7-day retention');
  await check('an 8-day-old report is visible before the restart', async () => {
    const db = new DatabaseSync(dbFile);
    db.exec(`INSERT INTO reports (type,title,category,color,location,date,time,contact,contactDetail,description,status,createdAt)
             VALUES ('found','Old umbrella','Other','Blue','Block C','2026-09-01','08:00','Old User','old@example.com','left behind','Open',
                     datetime('now','-8 days'))`);
    db.close();
    const rows = await (await fetch(base + '/reports')).json();
    if (rows.length !== 2) throw new Error(`expected 2 rows, got ${rows.length}`);
  });
  await check('startup purges it and keeps the fresh one', async () => {
    await stopServer(first);
    first = null;
    second = await startServer();
    const rows = await (await fetch(`http://127.0.0.1:${second.port}/reports`)).json();
    if (rows.length !== 1) throw new Error(`expected 1 row after the purge, got ${rows.length}`);
    if (rows[0].title !== report.title) throw new Error('the wrong report survived the purge');
  });
  await check('the coordinator session survives a restart', async () => {
    const res = await fetch(`http://127.0.0.1:${second.port}/reports`, { headers: { Authorization: `Bearer ${token}` } });
    const rows = await res.json();
    if (!('contactDetail' in rows[0])) throw new Error('session was not persisted');
  });
  await check('the changed admin password survives a restart', async () => {
    const res = await fetch(`http://127.0.0.1:${second.port}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'new-password-123' })
    });
    if (res.status !== 200) throw new Error('changed password was not persisted in settings');
  });
} finally {
  await stopServer(first);
  await stopServer(second);
  rmSync(workDir, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');
