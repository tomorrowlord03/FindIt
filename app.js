window.onerror = function(msg, url, line, col, error) {
  console.error("GLOBAL ERROR:", msg, "at line", line, "col", col, error ? error.stack : "");
};
const matchReports = window.FindItAlgorithms.findMatches;
let reports = [];
let adminToken = sessionStorage.getItem('findit_admin_token') || '';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  }[ch]));
}

function dateLabel(date) {
  return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function timeLabel(time) {
  return time ? new Date(`1970-01-01T${time}`).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : 'Time not provided';
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 2600);
}

async function fetchReports() {
  try {
    console.log("fetchReports start");
    const headers = {};
    if (adminToken) headers['Authorization'] = `Bearer ${adminToken}`;
    const res = await fetch('/reports', { headers });
    console.log("fetchReports response status:", res.status);
    if (res.ok) {
      reports = await res.json();
      console.log("fetchReports reports count:", reports.length);
    } else {
      console.warn('Failed to load reports from server:', res.status);
    }
  } catch (err) {
    console.error('Network error loading reports:', err);
  }
  try {
    console.log("refreshing views");
    refresh();
  } catch (err) {
    console.error("refresh error:", err);
  }
}

function navigate(view) {
  console.log("navigate called with:", view);
  $$('.view').forEach(el => el.classList.toggle('active-view', el.id === view));
  $$('[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  if (view === 'dashboard') renderDashboard();
  if (view === 'reports') renderReports();
  if (view === 'matches') renderMatches();
  if (view === 'admin') renderAdmin();
  try { window.scrollTo(0, 0); } catch (e) {}
}

function card(item) {
  return `<article class="report-card">
    <div class="report-type">
      <span class="pill ${item.type}">${item.type === 'lost' ? 'Lost' : 'Found'}</span>
      <span class="muted">${escapeHtml(item.status)}</span>
    </div>
    <h3>${escapeHtml(item.title)}</h3>
    <p>${escapeHtml(item.description)}</p>
    <p>📍 ${escapeHtml(item.location)} · ${escapeHtml(item.color)}</p>
    <div class="report-meta">
      <span>${escapeHtml(item.category)}</span>
      <span>${dateLabel(item.date)} · ${timeLabel(item.time)}</span>
    </div>
  </article>`;
}

function renderDashboard() {
  const open = reports.filter(r => r.status !== 'Returned').length;
  const matches = matchReports(reports).length;
  $('#stats').innerHTML = `
    <div class="stat"><strong>${reports.length}</strong><span>Total reports</span></div>
    <div class="stat"><strong>${reports.filter(r => r.type === 'lost').length}</strong><span>Lost items</span></div>
    <div class="stat"><strong>${reports.filter(r => r.type === 'found').length}</strong><span>Found items</span></div>
    <div class="stat"><strong>${open}</strong><span>Still active</span></div>`;
  $('#recentReports').innerHTML = reports.slice().reverse().slice(0, 3).map(card).join('') || '<div class="empty">No reports yet.</div>';
  $('#matchBadge').textContent = matches;
}

function renderReports() {
  const query = $('#searchInput').value.toLowerCase().trim();
  const type = $('#typeFilter').value;
  const category = $('#categoryFilter').value;
  const status = $('#statusFilter').value;
  const visible = reports.filter(r => {
    const haystack = `${r.title} ${r.description} ${r.color} ${r.location} ${r.category} ${r.time || ''}`.toLowerCase();
    return (!query || haystack.includes(query)) &&
           (type === 'all' || r.type === type) &&
           (category === 'all' || r.category === category) &&
           (status === 'all' || r.status === status);
  });
  $('#reportList').innerHTML = visible.map(item => `
    <div class="report-card">
      <div><span class="pill ${item.type}">${item.type === 'lost' ? 'Lost' : 'Found'}</span></div>
      <div><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.description)}</p></div>
      <div class="report-meta"><span>${escapeHtml(item.location)}<br>${dateLabel(item.date)} · ${timeLabel(item.time)}</span><span>${escapeHtml(item.status)}</span></div>
    </div>`).join('') || '<div class="empty">No reports match those filters.</div>';
}

function renderMatches() {
  const matches = matchReports(reports);
  $('#matchList').innerHTML = matches.map(match => `
    <article class="match-card">
      <div>
        <h3>${escapeHtml(match.lost.title)} <span class="muted">↔</span> ${escapeHtml(match.found.title)}</h3>
        <p>Lost at ${escapeHtml(match.lost.location)} on ${dateLabel(match.lost.date)} at ${timeLabel(match.lost.time)} · Found at ${escapeHtml(match.found.location)} on ${dateLabel(match.found.date)} at ${timeLabel(match.found.time)}</p>
        <div class="reasons">${match.reasons.map(reason => `<span class="reason">${escapeHtml(reason)}</span>`).join('')}</div>
      </div>
      <div class="score">${match.score}%<small>match score</small></div>
    </article>`).join('') || '<div class="empty">No possible matches yet. Add both a lost and a found report with a few shared details.</div>';
}

function renderAdmin() {
  const open = reports.filter(r => r.status !== 'Returned');
  $('#adminCount').textContent = `${open.length} active report${open.length === 1 ? '' : 's'}`;
  
  if (adminToken) {
    $('#adminLoginCard').style.display = 'none';
    $('#adminLogout').style.display = 'inline-block';
    if ($('#adminChangePassNavBtn')) $('#adminChangePassNavBtn').style.display = 'inline-block';
  } else {
    $('#adminLoginCard').style.display = 'block';
    $('#adminLogout').style.display = 'none';
    if ($('#adminChangePassNavBtn')) $('#adminChangePassNavBtn').style.display = 'none';
  }

  $('#adminList').innerHTML = reports.map(item => `
    <div class="admin-row">
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <small>${item.type === 'lost' ? 'Lost' : 'Found'} · Contact: ${escapeHtml(item.contact)}${item.contactDetail ? ' (' + escapeHtml(item.contactDetail) + ')' : ''} · ${escapeHtml(item.location)}</small>
      </div>
      <select data-status="${item.id}">
        ${['Open', 'Possible Match', 'Claimed', 'Returned'].map(status => `<option ${item.status === status ? 'selected' : ''}>${status}</option>`).join('')}
      </select>
      <button class="secondary" data-contact="${item.id}">Show contact</button>
    </div>`).join('') || '<div class="empty">No reports.</div>';
}

function refresh() {
  renderDashboard();
  if ($('#reports').classList.contains('active-view')) renderReports();
  if ($('#matches').classList.contains('active-view')) renderMatches();
  if ($('#admin').classList.contains('active-view')) renderAdmin();
}

// Navigation and Filters
$$('[data-view]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
['searchInput', 'typeFilter', 'categoryFilter', 'statusFilter'].forEach(id => $('#' + id).addEventListener('input', renderReports));

// Report Form Submission -> POST /reports
$('#reportForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const data = Object.fromEntries(formData);
  
  try {
    const res = await fetch('/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (res.ok) {
      toast('Your report was submitted to the campus server.');
      form.reset();
      $('#reportForm input[name="date"]').value = new Date().toISOString().slice(0, 10);
      $('#reportForm input[name="time"]').value = new Date().toTimeString().slice(0, 5);
      await fetchReports();
      navigate('reports');
    } else {
      const err = await res.json().catch(() => ({}));
      toast(err.error ? `Error: ${err.error}` : 'Submission failed.');
    }
  } catch (err) {
    console.error('Submit error:', err);
    toast('Network error submitting report.');
  }
});

// Admin Login Form -> POST /admin/login
$('#adminLoginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const creds = Object.fromEntries(formData);

  try {
    const res = await fetch('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds)
    });
    if (res.ok) {
      const { token } = await res.json();
      adminToken = token;
      sessionStorage.setItem('findit_admin_token', token);
      toast('Coordinator authenticated successfully.');
      await fetchReports();
    } else {
      const data = await res.json().catch(() => ({}));
      toast(data.error || (res.status === 429 ? 'Too many attempts. Please wait 1 minute.' : 'Invalid credentials. Check username/password.'));
    }
  } catch (err) {
    toast('Login request failed.');
  }
});

// Admin Logout
$('#adminLogout').addEventListener('click', () => {
  adminToken = '';
  sessionStorage.removeItem('findit_admin_token');
  toast('Coordinator logged out.');
  fetchReports();
});

// Toggle Change Password Card
$('#toggleChangePassBtn')?.addEventListener('click', () => {
  const card = $('#adminChangePassCard');
  card.style.display = 'block';
  try { card.scrollIntoView({ behavior: 'smooth' }); } catch (e) {}
});
$('#adminChangePassNavBtn')?.addEventListener('click', () => {
  const card = $('#adminChangePassCard');
  card.style.display = card.style.display === 'none' ? 'block' : 'none';
  if (card.style.display === 'block') {
    try { card.scrollIntoView({ behavior: 'smooth' }); } catch (e) {}
  }
});
$('#cancelChangePassBtn')?.addEventListener('click', () => {
  $('#adminChangePassCard').style.display = 'none';
});

// Admin Change Password Form -> POST /admin/change-password
$('#adminChangePassForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const formData = new FormData(form);
  const { oldPassword, newPassword, confirmPassword } = Object.fromEntries(formData);

  if (newPassword !== confirmPassword) {
    toast('New passwords do not match.');
    return;
  }
  if (newPassword.length < 4) {
    toast('New password must be at least 4 characters.');
    return;
  }

  try {
    if (!adminToken) {
      toast('Please log in as Coordinator first.');
      return;
    }
    const res = await fetch('/admin/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
      },
      body: JSON.stringify({ username: 'admin', oldPassword, newPassword })
    });
    if (res.ok) {
      toast('Coordinator password changed successfully.');
      form.reset();
      $('#adminChangePassCard').style.display = 'none';
      const passInput = $('#adminLoginForm input[name="password"]');
      if (passInput) passInput.value = '';
    } else {
      const err = await res.json().catch(() => ({}));
      toast(err.error ? `Error: ${err.error}` : 'Failed to change password. Check old password.');
    }
  } catch (err) {
    console.error('Password change error:', err);
    toast('Network error changing password.');
  }
});


// Status Change -> PATCH /admin/reports/:id
document.addEventListener('change', async event => {
  if (event.target.dataset.status) {
    const id = event.target.dataset.status;
    const status = event.target.value;

    if (!adminToken) {
      toast('Please log in as Coordinator to change status.');
      renderAdmin();
      return;
    }

    try {
      const res = await fetch(`/admin/reports/${id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
        body: JSON.stringify({ status })
      });
      if (res.ok) {
        const item = reports.find(r => String(r.id) === String(id));
        if (item) item.status = status;
        refresh();
        toast(`Status updated to ${status}.`);
      } else {
        toast('Failed to update status on server.');
        renderAdmin();
      }
    } catch (err) {
      toast('Network error updating status.');
      renderAdmin();
    }
  }
  if (event.target.id === 'categoryFilter') renderReports();
});

// Contact Detail View
document.addEventListener('click', event => {
  const id = event.target.dataset.contact;
  if (id) {
    const item = reports.find(r => String(r.id) === String(id));
    if (!item) return;
    if (item.contactDetail) {
      alert(`Coordinator contact for ${item.title}:\nName: ${item.contact}\nDetail: ${item.contactDetail}`);
    } else {
      alert(`Contact detail for "${item.title}" is restricted.\nPlease log in as Coordinator to view private contact details.`);
    }
  }
});

// Populate category dropdown
try {
  console.log("init started");
  const initialCategories = ['Identity card', 'Electronics', 'Books & stationery', 'Keys', 'Wallet / money', 'Clothing', 'Other'];
  const cat = $('#categoryFilter');
  if (cat) cat.insertAdjacentHTML('beforeend', initialCategories.map(c => `<option>${escapeHtml(c)}</option>`).join(''));
  const dIn = $('#reportForm input[name="date"]');
  if (dIn) dIn.value = new Date().toISOString().slice(0, 10);
  const tIn = $('#reportForm input[name="time"]');
  if (tIn) tIn.value = new Date().toTimeString().slice(0, 5);
  console.log("init calling fetchReports");
  fetchReports();
} catch (e) {
  console.error("Init failed:", e);
}
