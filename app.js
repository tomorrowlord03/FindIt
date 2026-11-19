'use strict';

const byId = id => document.getElementById(id);
const text = value => String(value ?? '');
const escapeHtml = value => text(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[char]);
const pathPart = value => escapeHtml(encodeURIComponent(value));
const empty = message => '<p class="empty">' + escapeHtml(message) + '</p>';
let reports = [], suggestions = [], loaded = false, loading = false, loadError = '';
let active = '', claimTarget = '', linkedTarget = '', limit = 30;
let lastReceipt = null, adminEpoch = 0, expiryTimer = 0, lockFailed = false;
const pendingKeys = new Map();

async function api(path, body) {
  const options = {cache: 'no-store', credentials: 'same-origin', headers: {Accept: 'application/json'}};
  if (body !== undefined) {
    options.method = 'POST';
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await fetch('/api/' + path, options).catch(() => {
    throw new Error('Could not reach FindIt. Check your connection and retry.');
  });
  let data;
  try { data = await response.json(); } catch {
    throw new Error('FindIt returned an unreadable response. Please retry.');
  }
  if (!response.ok) {
    const error = new Error(text(data?.error || 'The request could not be completed.'));
    error.status = response.status;
    throw error;
  }
  if (!data || typeof data !== 'object') throw new Error('Unexpected response from FindIt.');
  return data;
}

function localDate() {
  const date = new Date();
  return [date.getFullYear(), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')].join('-');
}

function dateLabel(value) {
  const date = new Date(value + 'T12:00:00');
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleDateString('en-IN', {day:'numeric',month:'short',year:'numeric'});
}

function setNotice() {
  const notice = byId('boardNotice');
  notice.hidden = !['dashboard','reports','matches','claim'].includes(active) || (!loading && !loadError);
  notice.innerHTML = loadError
    ? escapeHtml(loadError) + (loaded ? ' Showing the last loaded board.' : '') + ' <button class="secondary" data-retry-board>Retry loading</button>'
    : (loading ? 'Loading campus reports…' : '');
}

function openFound(report) {
  return report.type === 'found' && ['Open','Possible Match'].includes(report.status);
}

function claimLink(found, lost) {
  if (!openFound(found)) return '';
  const url = '#claim/' + pathPart(found.id) + (lost ? '/' + pathPart(lost.id) : '');
  return '<a class="link-button card-action" href="' + url + '">This may be mine</a>';
}

function card(report) {
  const type = report.type === 'lost' ? 'Lost' : 'Found';
  return '<article class="report-card"><div class="report-type"><span class="pill ' + type.toLowerCase() + '">' + type +
    '</span><span class="muted">' + escapeHtml(report.status) + '</span></div><div><h3>' + escapeHtml(report.title) +
    '</h3><p>' + escapeHtml(report.description) + '</p></div><div class="report-meta"><span>' +
    escapeHtml(report.location) + ' · ' + escapeHtml(dateLabel(report.date)) + '</span><span>' + escapeHtml(report.category) +
    (report.color ? ' · ' + escapeHtml(report.color) : '') + '</span></div>' + claimLink(report) + '</article>';
}

function refreshFilters() {
  for (const [id, key, title] of [['categoryFilter','category','All categories'],['statusFilter','status','All statuses']]) {
    const select = byId(id), previous = select.value;
    const entries = [...new Set(reports.map(r=>r[key]).filter(Boolean))].sort();
    select.replaceChildren(new Option(title, ''), ...entries.map(value=>new Option(value,value)));
    if (entries.includes(previous)) select.value = previous;
  }
}

function drawBoard() {
  setNotice();
  if (!loaded) {
    byId('recentReports').replaceChildren(); byId('reportList').replaceChildren();
    byId('resultsCount').textContent = ''; byId('matchList').replaceChildren();
    byId('showMore').hidden = true;
  } else if (active === 'dashboard') {
    byId('recentReports').innerHTML = reports.slice(0, 3).map(card).join('') || empty('No reports yet. Be the first to report a lost or found item.');
  } else if (active === 'reports') {
    const query = byId('searchInput').value.trim().toLocaleLowerCase();
    const filtered = reports.filter(r => (!byId('typeFilter').value || r.type === byId('typeFilter').value)
      && (!byId('categoryFilter').value || r.category === byId('categoryFilter').value)
      && (!byId('statusFilter').value || r.status === byId('statusFilter').value)
      && [r.title,r.description,r.location,r.color,r.category].join(' ').toLocaleLowerCase().includes(query));
    byId('resultsCount').textContent = filtered.length + (filtered.length === 1 ? ' report' : ' reports');
    byId('reportList').innerHTML = filtered.slice(0,limit).map(card).join('') || empty(reports.length ? 'No reports match these filters. Try another location or clear a filter.' : 'No reports have been published yet.');
    byId('showMore').hidden = filtered.length <= limit;
  } else if (active === 'matches') {
    byId('matchList').innerHTML = suggestions.map(({found,lost,score,reasons}) =>
      '<article class="match-card"><div><h2>' + escapeHtml(lost.title) + ' &amp; ' + escapeHtml(found.title) +
      '</h2><p>Lost at ' + escapeHtml(lost.location) + ' · ' + escapeHtml(dateLabel(lost.date)) +
      '</p><p>Found at ' + escapeHtml(found.location) + ' · ' + escapeHtml(dateLabel(found.date)) +
      '</p><div class="reasons">' + reasons.map(why=>'<span class="reason">'+escapeHtml(why)+'</span>').join('') +
      '</div>' + claimLink(found,lost) + '</div><div class="score">' + escapeHtml(score) + '<small>match points</small></div></article>'
    ).join('') || empty('No strong suggestions yet. Browse the board or add your own report.');
  }
  if (active === 'claim') {
    const item = reports.find(r=>r.id === claimTarget);
    byId('claimForm').hidden = !item || !openFound(item);
    byId('claimItem').textContent = !loaded ? 'Looking up the report…' : (!item || !openFound(item))
      ? 'This item is no longer available for claims.' : 'Claiming ' + item.title + ' · ' + item.location + ' · ' + dateLabel(item.date);
  }
}

async function loadBoard() {
  if (loading) return;
  loading = true; loadError = ''; setNotice();
  try {
    const data = await api('reports');
    if (!Array.isArray(data.reports)) throw new Error('The board response was incomplete.');
    const matches = window.FindItAlgorithms.findMatches(data.reports, {limit:25});
    reports = data.reports; suggestions = matches; loaded = true; refreshFilters();
  } catch(error) { loadError = error.message; }
  finally { loading = false; drawBoard(); }
}

async function loadConfig() {
  let config = {};
  try { config = await api('config'); } catch { /* The claim receipt still provides the next step. */ }
  document.querySelectorAll('.pickup-info').forEach(element => {
    element.replaceChildren();
    for (const [label, value] of [['Pickup desk',config.desk],['Hours',config.hours],['Contact',config.contact]]) {
      if (value) { const p = document.createElement('p'); p.textContent = label + ' · ' + value; element.append(p); }
    }
    if (!config.desk) element.textContent = 'Wait for pickup instructions from the coordinator before travelling.';
  });
  byId('retention').textContent = Number(config.retentionDays) > 0
    ? 'Public listings are available for up to ' + Number(config.retentionDays) + ' days.' : '';
}

function displayReceipt() {
  let receipt = lastReceipt;
  if (!receipt) {
    try { receipt = JSON.parse(sessionStorage.getItem('findit.receipt')); } catch { /* Storage is optional. */ }
  }
  const valid = receipt && typeof receipt.reference === 'string' && ['report','claim'].includes(receipt.kind);
  byId('reference').textContent = valid ? receipt.reference : '';
  byId('receiptText').textContent = valid ? (receipt.kind === 'report' ? 'Report published.' : 'Private claim submitted.') + ' Save this reference for follow-up.' : 'There is no recent submission reference in this tab.';
  byId('receiptNext').textContent = valid ? (receipt.kind === 'report' ? 'Browse the board or check possible matches while the coordinator reviews new claims.' : 'The coordinator will review your clue and use your contact details to follow up.') : '';
}

function rememberReceipt(kind, reference) {
  if (!reference || typeof reference !== 'string') throw new Error('No receipt was received. Retry the same submission.');
  lastReceipt = {kind,reference};
  try { sessionStorage.setItem('findit.receipt', JSON.stringify(lastReceipt)); } catch { /* The receipt remains visible. */ }
}

function route() {
  const [view='dashboard', id='', linked=''] = location.hash.slice(1).split('/');
  const page = ['dashboard','report','reports','matches','claim','receipt','admin'].includes(view) ? view : 'dashboard';
  const decode = part => { try { return decodeURIComponent(part); } catch { return ''; } };
  if (claimTarget !== decode(id) || linkedTarget !== decode(linked) || (active === 'claim' && page !== 'claim')) {
    byId('claimForm').reset(); byId('claimForm').querySelector('.form-error').textContent = '';
  }
  if (active === 'admin' && page !== 'admin') clearAdmin();
  active = page; claimTarget = decode(id); linkedTarget = decode(linked);
  document.querySelectorAll('section.view').forEach(section => {
    const shown = section.id === active;
    section.hidden = !shown; section.classList.toggle('active-view',shown);
  });
  document.querySelectorAll('.nav-link').forEach(link => {
    const current = link.hash === '#' + page;
    link.classList.toggle('active',current);
    if (current) link.setAttribute('aria-current','page'); else link.removeAttribute('aria-current');
  });
  const heading = byId(active).querySelector('h1');
  document.title = heading.textContent + ' | FindIt';
  if (location.hash) { heading.focus({preventScroll:true}); window.scrollTo(0,0); }
  drawBoard();
  if (active === 'receipt') displayReceipt();
  if (active === 'admin') checkAdmin();
}

function setBusy(form, busy) {
  form.dataset.busy = busy ? 'true' : 'false';
  form.setAttribute('aria-busy',String(busy));
  for (const field of form.querySelectorAll('fieldset, button[type="submit"]')) field.disabled = busy;
}

function requestKey(form, payload) {
  const serialized = JSON.stringify(payload);
  let cached = pendingKeys.get(form.id);
  if (!cached || cached.serialized !== serialized) {
    cached = {serialized, requestId:crypto.randomUUID()};
    pendingKeys.set(form.id,cached);
  }
  return cached.requestId;
}

async function submitPublic(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.busy === 'true') return;
  const kind = form.id === 'reportForm' ? 'report' : 'claim';
  const body = Object.fromEntries(new FormData(form));
  if (kind === 'claim') {
    body.reportId = claimTarget;
    if (linkedTarget) body.linkedReportId = linkedTarget;
  }
  const oldRoute = location.hash;
  const feedback = form.querySelector('.form-error');
  feedback.textContent = ''; setBusy(form,true);
  try {
    body.requestId = requestKey(form,body);
    const result = await api(kind === 'report' ? 'reports' : 'claims', body);
    rememberReceipt(kind, result.reference);
    pendingKeys.delete(form.id); form.reset();
    if (kind === 'report') form.elements.date.value = localDate();
    if (location.hash === oldRoute) location.hash = 'receipt';
    loadBoard();
  } catch(error) {
    feedback.textContent = error.message + ' Your entries are still here.';
  } finally { setBusy(form,false); }
}
function clearAdmin() {
  adminEpoch++; clearTimeout(expiryTimer);
  byId('adminList').replaceChildren();
  byId('adminTools').hidden = true; byId('coordinatorLogin').hidden = true;
  byId('coordinatorLogin').reset(); byId('coordinatorLogin').querySelector('.form-error').textContent = '';
  const passwordForm = byId('changePassword');
  passwordForm.hidden = true;
  passwordForm.reset();
  passwordForm.querySelector('.form-error').textContent = '';
  passwordForm.querySelector('.notice').textContent = '';
  byId('adminStatus').textContent = '';
}

function retryAdmin(message) {
  byId('adminStatus').textContent = message + ' ';
  const retry = document.createElement('button');
  retry.className = 'secondary'; retry.textContent = lockFailed ? 'Retry lock' : 'Retry';
  retry.addEventListener('click',lockFailed ? logout : checkAdmin);
  byId('adminStatus').append(retry);
}

function details(name, value) {
  return value ? '<p><strong>' + escapeHtml(name) + '</strong> · ' + escapeHtml(value) + '</p>' : '';
}

function coordinatorQueue(data) {
  if (![data.reports,data.claims,data.history].every(Array.isArray)) throw new Error('The coordinator queue was incomplete.');
  const items = new Map(data.reports.map(r=>[r.id,r]));
  const eligible = data.reports.filter(r=>r.type === 'lost' && ['Open','Possible Match'].includes(r.status));
  const queue = data.claims.map(claim=>{
    const found = items.get(claim.reportId);
    const resolved = ['Returned','Declined'].includes(claim.status);
    const options = eligible.map(r=>'<option value="' + escapeHtml(r.id) + '"' + (claim.linkedReportId === r.id ? ' selected' : '') +
      '>' + escapeHtml(r.title + ' · ' + r.location + ' · ' + r.id) + '</option>').join('');
    return '<article class="admin-card"><h3>' + escapeHtml(found?.title || 'Archived item') + '</h3>' +
      details('Claim',claim.reference) + details('Status',claim.status) + details('Claimant',claim.contact) +
      details('Contact',claim.contactDetail) + details('Claimant evidence',claim.proof) +
      details('Report verification clue',found?.privateClue) +
      (resolved ? '' : '<form class="handover-form" data-reference="' + escapeHtml(claim.reference) +
      '"><fieldset class="form-section"><legend>Review claim</legend><div class="form-grid"><label>Decision<select name="decision" required>' +
      '<option value="">Choose a decision</option><option value="Returned">Confirm item returned</option><option value="Declined">Decline claim</option></select></label>' +
      '<label>Linked lost report (optional)<select name="linkedReportId"><option value="">No linked report</option>' + options +
      '</select></label><label class="full">Verification or decision note<textarea required name="note" maxlength="600" rows="2"></textarea></label></div>' +
      '</fieldset><p class="field-hint">Confirm a return after pickup. The found report and any linked lost report will close together.</p>' +
      '<p class="form-error" role="alert"></p><button type="submit" class="primary">Save decision</button></form>') + '</article>';
  }).join('');
  const records = data.reports.map(r=>'<details class="admin-card"><summary>' + escapeHtml(r.title + ' · ' + r.status) +
    '</summary>' + details('Report',r.id) + details('Reporter',r.contact) + details('Contact',r.contactDetail) +
    details('Private clue',r.privateClue) + '</details>').join('');
  const history = data.history.map(h=>'<li>' + escapeHtml([h.createdAt,h.action,h.reference,h.actor,h.note].filter(Boolean).join(' · ')) + '</li>').join('');
  byId('adminList').innerHTML = '<h2>Claims</h2>' + (queue || empty('No claims to review.')) +
    '<h2>Report contacts</h2>' + (records || empty('No reports on file.')) + '<h2>Handover history</h2>' +
    (history ? '<ul class="admin-card">' + history + '</ul>' : empty('No decisions recorded yet.'));
}

async function checkAdmin() {
  clearAdmin();
  if (active !== 'admin' || document.hidden) return;
  if (lockFailed) { retryAdmin('Private details are hidden. Server sign-out is still pending.'); return; }
  const epoch = adminEpoch;
  byId('adminStatus').textContent = 'Checking coordinator access…';
  try {
    const session = await api('session');
    if (epoch !== adminEpoch) return;
    if (session.authenticated !== true) {
      byId('adminStatus').textContent = ''; byId('coordinatorLogin').hidden = false; return;
    }
    const data = await api('admin');
    if (epoch !== adminEpoch) return;
    const until = Number(data.expiresAt || session.expiresAt)*1000 - Date.now();
    if (!(until > 0)) throw Object.assign(new Error('Session expired. Sign in again.'),{status:401});
    coordinatorQueue(data);
    byId('adminTools').hidden = false;
    byId('changePassword').hidden = false;
    byId('adminStatus').textContent = '';
    expiryTimer = setTimeout(() => { clearAdmin(); byId('coordinatorLogin').hidden = false;
      byId('adminStatus').textContent = 'Your session expired. Sign in again.'; },until);
  } catch(error) {
    if (epoch !== adminEpoch) return;
    clearAdmin();
    if (error.status === 401) { byId('coordinatorLogin').hidden = false; byId('adminStatus').textContent = 'Sign in to review claims.'; }
    else retryAdmin(error.message);
  }
}

async function logout() {
  clearAdmin(); lockFailed = true;
  byId('adminStatus').textContent = 'Locking coordinator access…';
  try {
    await api('logout',{}); lockFailed = false;
    if (active === 'admin') { byId('coordinatorLogin').hidden = false; byId('adminStatus').textContent = 'Coordinator view locked.'; }
  } catch(error) { if (active === 'admin') retryAdmin('Private details are hidden. Server sign-out could not be confirmed.'); }
}

async function login(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.busy === 'true') return;
  const data = Object.fromEntries(new FormData(form));
  const epoch = adminEpoch;
  setBusy(form,true); form.querySelector('.form-error').textContent = '';
  try {
    await api('login',data); form.reset();
    if (epoch === adminEpoch && active === 'admin') await checkAdmin();
  } catch(error) { if (epoch === adminEpoch) form.querySelector('.form-error').textContent = error.message; }
  finally { setBusy(form,false); }
}

async function changePassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (form.dataset.busy === 'true') return;
  const data = Object.fromEntries(new FormData(form));
  const epoch = adminEpoch;
  const feedback = form.querySelector('.notice');
  const inlineError = form.querySelector('.form-error');
  form.reset();
  feedback.textContent = inlineError.textContent = '';
  setBusy(form,true);
  try {
    await api('admin/change-password',data);
    if (epoch === adminEpoch) feedback.textContent = 'Password changed. Other coordinator sessions were signed out.';
  } catch(error) {
    if (epoch !== adminEpoch) return;
    if (error.status === 401) await checkAdmin();
    else inlineError.textContent = error.message;
  } finally { setBusy(form,false); }
}

async function resolve(event) {
  const form = event.target.closest('.handover-form');
  if (!form) return;
  event.preventDefault();
  if (form.dataset.busy === 'true') return;
  const body = Object.fromEntries(new FormData(form)); body.reference = form.dataset.reference;
  const epoch = adminEpoch;
  setBusy(form,true);
  try {
    await api('claims/resolve',body);
    if (epoch === adminEpoch) {
      await checkAdmin();
      if (!byId('adminTools').hidden) {
        byId('adminStatus').textContent = 'Decision saved for ' + body.reference + '.';
        byId('refreshAdmin').focus();
      }
    }
    loadBoard();
  } catch(error) {
    if (error.status === 401 && epoch === adminEpoch) await checkAdmin();
    else form.querySelector('.form-error').textContent = error.message;
  } finally { setBusy(form,false); }
}

byId('reportForm').elements.date.value = localDate();
byId('reportForm').addEventListener('submit',submitPublic);
byId('claimForm').addEventListener('submit',submitPublic);
byId('coordinatorLogin').addEventListener('submit',login);
byId('changePassword').addEventListener('submit',changePassword);
byId('refreshAdmin').addEventListener('click',checkAdmin);
byId('lockView').addEventListener('click',logout);
byId('adminList').addEventListener('submit',resolve);
byId('boardNotice').addEventListener('click',e=>{ if (e.target.closest('[data-retry-board]')) loadBoard(); });
for (const id of ['searchInput','typeFilter','categoryFilter','statusFilter']) {
  byId(id).addEventListener('input',()=>{ limit=30; drawBoard(); });
}
byId('showMore').addEventListener('click',()=>{ limit+=30; drawBoard(); });
document.querySelector('.skip-link').addEventListener('click',e=>{ e.preventDefault(); byId('main').focus(); });
window.addEventListener('hashchange',route);
document.addEventListener('visibilitychange',()=>{
  if (active === 'admin') { if (document.hidden) clearAdmin(); else checkAdmin(); }
  else if (!document.hidden) loadBoard();
});
window.addEventListener('pagehide',clearAdmin);
window.addEventListener('pageshow',e=>{ if (e.persisted) {route(); loadBoard();} });
route(); loadBoard(); loadConfig();
