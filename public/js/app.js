// ================= i18n helpers =================
function t(key) { return (LANG[currentLang] || LANG.en)[key] || (LANG.en)[key] || null; }
function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => { const v = t(el.dataset.i18n); if (v != null) el.textContent = v; });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { const v = t(el.dataset.i18nHtml); if (v != null) el.innerHTML = v; });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { const v = t(el.dataset.i18nPlaceholder); if (v != null) el.placeholder = v; });
  document.documentElement.lang = currentLang === 'zh' ? 'zh-Hant' : 'en';
  const lb = document.getElementById('langBtn');
  if (lb) lb.textContent = currentLang === 'en' ? '中' : 'EN';
}
function toggleLang() {
  currentLang = currentLang === 'en' ? 'zh' : 'en';
  localStorage.setItem('lang', currentLang);
  applyTranslations();
  if (isLoggedIn()) {
    loadOverview();
  }
}

// ================= State & Storage =================
const API = '';
const K = { id: 'a2a_agent_id', key: 'a2a_api_key', name: 'a2a_agent_name' };
const state = { txPage: 1, txTotal: 0, txFilter: 'all', txStatus: 'all', txQuery: '', activePanel: 'overview' };
let txSearchTimer;

function getAuth() {
  return { id: localStorage.getItem(K.id), key: localStorage.getItem(K.key), name: localStorage.getItem(K.name) };
}
function isLoggedIn() {
  const a = getAuth();
  return !!(a.id && a.key);
}
function setAuth(id, key, name) {
  localStorage.setItem(K.id, id);
  localStorage.setItem(K.key, key);
  if (name) localStorage.setItem(K.name, name);
}
function clearAuth() {
  localStorage.removeItem(K.id);
  localStorage.removeItem(K.key);
  localStorage.removeItem(K.name);
}
function authHeaders() {
  const k = localStorage.getItem(K.key);
  return k ? { 'X-API-Key': k } : {};
}

// ================= HTTP =================
const ERROR_MESSAGES = {
  'Failed to fetch': 'Network error. Please check your connection and try again.',
  'NetworkError': 'Unable to reach the server. Please check your internet connection.',
  'HTTP 401': 'Authentication failed. Please check your credentials.',
  'HTTP 403': 'You do not have permission to perform this action.',
  'HTTP 404': 'The requested resource was not found.',
  'HTTP 429': 'Too many requests. Please wait a moment and try again.',
  'HTTP 500': 'Server error. Please try again later.',
  'HTTP 502': 'Server temporarily unavailable. Please try again.',
  'HTTP 503': 'Service temporarily unavailable. Please try again later.',
};

function friendlyError(msg) {
  if (!msg) return 'An unexpected error occurred.';
  for (const [key, friendly] of Object.entries(ERROR_MESSAGES)) {
    if (msg.includes(key)) return friendly;
  }
  if (/^HTTP \d{3}$/.test(msg)) return 'Something went wrong. Please try again.';
  return msg;
}

let _isOffline = false;
window.addEventListener('online', () => {
  _isOffline = false;
  toast(t('net_online'), 'success');
});
window.addEventListener('offline', () => {
  _isOffline = true;
  toast(t('net_offline'), 'error', 6000);
});

async function api(path, opts = {}, _retries = 2) {
  if (_isOffline) throw new Error('You are offline. Please check your connection.');
  opts.headers = opts.headers || {};
  if (opts.body && !opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(API + path, opts);
  } catch (e) {
    if (_retries > 0) { await new Promise(r => setTimeout(r, 1500)); return api(path, opts, _retries - 1); }
    throw new Error(friendlyError(e.message));
  }
  if ((res.status === 502 || res.status === 503) && _retries > 0) {
    await new Promise(r => setTimeout(r, 2000));
    return api(path, opts, _retries - 1);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(friendlyError(data.error || ('HTTP ' + res.status)));
  return data;
}

// ================= Skeleton Loading =================
function showSkeleton(container, count = 3) {
  if (typeof container === 'string') container = document.getElementById(container);
  if (!container) return;
  const skeletons = Array.from({ length: count }, () => `
    <div class="skeleton-card" aria-hidden="true">
      <div class="skeleton-line skeleton-title"></div>
      <div class="skeleton-line skeleton-text"></div>
      <div class="skeleton-line skeleton-text short"></div>
    </div>`).join('');
  container.innerHTML = `<div class="skeleton-wrap">${skeletons}</div>`;
}

// Inject skeleton + utility CSS once
(function injectAppCSS() {
  if (document.getElementById('app-styles')) return;
  const style = document.createElement('style');
  style.id = 'app-styles';
  style.textContent = `
    @keyframes skeleton-shimmer {
      0% { background-position: -200px 0; }
      100% { background-position: calc(200px + 100%) 0; }
    }
    .skeleton-wrap { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
    .skeleton-card {
      background: var(--fill-secondary, #1a1a1e);
      border: 1px solid var(--border, #333);
      border-radius: 12px;
      padding: 20px;
    }
    .skeleton-line {
      height: 14px;
      border-radius: 6px;
      margin-bottom: 12px;
      background: linear-gradient(90deg, var(--border, #333) 25%, var(--fill-secondary, #2a2a2e) 50%, var(--border, #333) 75%);
      background-size: 200px 100%;
      animation: skeleton-shimmer 1.5s ease-in-out infinite;
    }
    .skeleton-line.skeleton-title { width: 65%; height: 18px; margin-bottom: 16px; }
    .skeleton-line.skeleton-text { width: 90%; }
    .skeleton-line.skeleton-text.short { width: 50%; }

    .confirm-overlay {
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.55);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10001;
      animation: fadeIn 0.15s ease;
    }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    .confirm-box {
      background: var(--bg-soft, #1a1a1e);
      border: 1px solid var(--border, #333);
      border-radius: 14px;
      padding: 28px;
      max-width: 400px;
      width: 90%;
      box-shadow: 0 20px 60px rgba(0,0,0,0.4);
    }
    .confirm-box h3 { margin: 0 0 8px; font-size: 16px; }
    .confirm-box p { margin: 0 0 20px; font-size: 13px; color: var(--text-soft, #999); line-height: 1.6; }
    .confirm-box .btn-row { display: flex; gap: 8px; justify-content: flex-end; }

    .btn.btn-loading {
      pointer-events: none;
      opacity: 0.7;
      position: relative;
    }

    .load-more-bar {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      padding: 16px 0;
      margin-top: 8px;
    }
    .load-more-bar .count {
      font-size: 12px;
      color: var(--text-soft, #999);
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    .code-block {
      position: relative;
      background: var(--bg, #0d0d0f);
      border: 1px solid var(--border, #333);
      border-radius: 8px;
      overflow: hidden;
      margin: 8px 0;
    }
    .code-block .code-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 12px;
      background: var(--fill-secondary, #1a1a1e);
      border-bottom: 1px solid var(--border, #333);
      font-size: 11px;
      color: var(--text-soft, #999);
    }
    .code-block pre {
      margin: 0;
      padding: 12px;
      font-size: 12px;
      line-height: 1.5;
      overflow-x: auto;
      color: var(--text, #eee);
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    }
    .code-block .copy-code-btn {
      background: none;
      border: 1px solid var(--border, #333);
      color: var(--text-soft, #999);
      padding: 2px 8px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
    }
    .code-block .copy-code-btn:hover { color: var(--text, #eee); border-color: var(--text-soft, #999); }

    .status-badge {
      display: inline-block;
      padding: 2px 10px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .status-badge.st-escrowed, .status-badge.st-paid { background: var(--warn-bg, #3a2f00); color: var(--warn, #f5a623); }
    .status-badge.st-delivered { background: var(--info-bg, #002a4a); color: var(--info, #4a9eff); }
    .status-badge.st-completed { background: var(--success-bg, #003a00); color: var(--success, #34c759); }
    .status-badge.st-disputed { background: var(--danger-bg, #3a0000); color: var(--danger, #e55); }
    .status-badge.st-refunded { background: var(--fill-secondary, #1a1a1e); color: var(--text-soft, #999); }
  `;
  document.head.appendChild(style);
})();

// ================= Toast =================
function toast(msg, type = 'info', ms) {
  if (ms === undefined) {
    if (type === 'success') ms = 2000;
    else if (type === 'error') ms = 5000;
    else ms = 3500;
  }
  const container = document.getElementById('toasts');
  if (!container) return;
  if (!container.hasAttribute('aria-live')) {
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'false');
    container.setAttribute('role', 'status');
  }
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.setAttribute('role', 'alert');
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 300);
  }, ms);
}

// ================= Confirmation Modal =================
function confirmAction({ title, message, confirmText, cancelText, danger, onConfirm }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', title || 'Confirmation');
    const btnClass = danger ? 'btn btn-danger' : 'btn btn-primary';
    overlay.innerHTML = `
      <div class="confirm-box">
        <h3>${escapeHtml(title || (currentLang === 'en' ? 'Are you sure?' : '確認操作'))}</h3>
        <p>${escapeHtml(message || '')}</p>
        <div class="btn-row">
          <button class="btn btn-ghost confirm-cancel">${escapeHtml(cancelText || t('common_cancel'))}</button>
          <button class="${btnClass} confirm-ok">${escapeHtml(confirmText || t('common_confirm'))}</button>
        </div>
      </div>
    `;
    const cleanup = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector('.confirm-cancel').addEventListener('click', () => cleanup(false));
    overlay.querySelector('.confirm-ok').addEventListener('click', () => { if (onConfirm) onConfirm(); cleanup(true); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') cleanup(false); });
    document.body.appendChild(overlay);
    overlay.querySelector('.confirm-ok').focus();
  });
}

// ================= Modal =================
function modal(html) {
  const modalEl = document.getElementById('modal');
  const bodyEl = document.getElementById('modalBody');
  if (!modalEl || !bodyEl) return;
  bodyEl.innerHTML = html;
  modalEl.classList.add('show');
  modalEl.setAttribute('role', 'dialog');
  modalEl.setAttribute('aria-modal', 'true');
  requestAnimationFrame(() => {
    const firstInput = bodyEl.querySelector('input:not([type="hidden"]), textarea, select');
    if (firstInput) firstInput.focus();
  });
}
function closeModal() {
  const modalEl = document.getElementById('modal');
  if (modalEl) modalEl.classList.remove('show');
}

// Modal backdrop click
(function initModalListeners() {
  const modalEl = document.getElementById('modal');
  if (!modalEl) return;
  modalEl.addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

  // Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalEl.classList.contains('show')) {
      closeModal();
      e.preventDefault();
    }
  });

  // Tab trapping
  modalEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const bodyEl = document.getElementById('modalBody');
    const focusable = bodyEl.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { last.focus(); e.preventDefault(); }
    } else {
      if (document.activeElement === last) { first.focus(); e.preventDefault(); }
    }
  });
})();

// ================= Helpers =================
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function money(n) { return parseFloat(n || 0).toFixed(2); }

function copyToClipboard(text) {
  navigator.clipboard.writeText(text)
    .then(() => toast(t('toast_copied'), 'success'))
    .catch(() => toast(t('toast_copy_fail'), 'error'));
}
function copyText(text) { copyToClipboard(text); }

function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

function btnLoading(btn, text) {
  if (!btn) return;
  btn._origText = btn.textContent;
  btn._origDisabled = btn.disabled;
  btn.disabled = true;
  btn.textContent = text || t('common_processing');
  btn.classList.add('btn-loading');
}
function btnRestore(btn) {
  if (!btn) return;
  btn.disabled = btn._origDisabled || false;
  btn.textContent = btn._origText || '';
  btn.classList.remove('btn-loading');
}

function renderErrorWithRetry(message, retryFn) {
  return `<div style="text-align:center;padding:24px;">
    <div style="color:var(--danger,#e55);margin-bottom:12px;font-size:13px">${escapeHtml(friendlyError(message))}</div>
    <button class="btn btn-ghost btn-sm" onclick="(${retryFn.toString()})()">${t('common_retry')}</button>
  </div>`;
}

function statusLabel(s) {
  return ({
    paid: t('tx_status_paid'),
    delivered: t('tx_status_delivered'),
    completed: t('tx_status_completed'),
    disputed: t('tx_status_disputed'),
    refunded: t('tx_status_refunded')
  })[s] || s;
}

function statusBadgeClass(s) {
  const map = {
    paid: 'st-paid',
    escrowed: 'st-escrowed',
    delivered: 'st-delivered',
    completed: 'st-completed',
    disputed: 'st-disputed',
    refunded: 'st-refunded'
  };
  return map[s] || 'st-paid';
}

// ================= New Utility Functions =================

function relativeTime(dateStr) {
  if (!dateStr) return '';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  if (diff < 0) return '';
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return t('time_just_now');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + t('time_m_ago');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + t('time_h_ago');
  const days = Math.floor(hours / 24);
  return days + t('time_d_ago');
}

function maskApiKey(key) {
  if (!key || key.length < 10) return key || '';
  return key.slice(0, 3) + '****' + key.slice(-4);
}

function renderCodeBlock(code, lang) {
  const id = 'code-' + Math.random().toString(36).slice(2, 8);
  return `<div class="code-block">
    <div class="code-header">
      <span>${escapeHtml(lang || '')}</span>
      <button class="copy-code-btn" onclick="copyToClipboard(document.getElementById('${id}').textContent)">${t('common_copy')}</button>
    </div>
    <pre id="${id}">${escapeHtml(code)}</pre>
  </div>`;
}

function showQuickStart() {
  const a = getAuth();
  const apiKey = a.key || 'YOUR_API_KEY';
  const agentId = a.id || 'YOUR_AGENT_ID';
  const code = `const API = '${location.origin}';
const AGENT_ID = '${agentId}';
const API_KEY = '${apiKey}';

// Place an order
const order = await fetch(API + '/orders', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': API_KEY
  },
  body: JSON.stringify({
    service_id: 'SERVICE_ID',
    requirements: 'Analyze TSLA stock for today'
  })
}).then(r => r.json());

console.log('Order created:', order.id);
console.log('Status:', order.status); // "paid"

// Deliver an order (as seller)
const delivery = await fetch(API + '/orders/' + order.id + '/deliver', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': API_KEY
  },
  body: JSON.stringify({
    content: JSON.stringify({ analysis: '...', recommendation: 'buy' })
  })
}).then(r => r.json());

console.log('Delivered! Status:', delivery.status);`;

  modal(`
    <button class="close" onclick="closeModal()">&times;</button>
    <h2>${t('landing_code_title')}</h2>
    <p class="mdesc">${t('landing_code_sub')}</p>
    ${renderCodeBlock(code, 'javascript')}
    <div style="margin-top:12px">
      <a class="btn btn-ghost btn-sm" href="/docs" target="_blank">${t('api_docs')}</a>
    </div>
  `);
}

// ================= Two-Mode Rendering =================

function showLanding() {
  const landing = document.getElementById('landing');
  const dashboard = document.getElementById('dashboard');
  if (landing) landing.style.display = '';
  if (dashboard) dashboard.style.display = 'none';
  loadLandingStats();
}

function showDashboard() {
  const landing = document.getElementById('landing');
  const dashboard = document.getElementById('dashboard');
  if (landing) landing.style.display = 'none';
  if (dashboard) dashboard.style.display = '';
  switchPanel('overview');
}

async function loadLandingStats() {
  try {
    const s = await api('/api/stats');
    const el = (id) => document.getElementById(id);
    if (el('ls-agents')) el('ls-agents').textContent = s.agents || 0;
    if (el('ls-orders')) el('ls-orders').textContent = s.completed_orders || 0;
    if (el('ls-volume')) el('ls-volume').textContent = money(s.total_volume || s.platform_fees || 0);
    if (el('ls-uptime')) el('ls-uptime').textContent = '99.9%';
    if (el('ls-disputes')) el('ls-disputes').textContent = s.active_disputes || 0;
  } catch (e) { console.error('Stats load error:', e); }
  loadLandingLeaderboard();
}

async function loadLandingLeaderboard() {
  const el = document.getElementById('landing-leaderboard');
  if (!el) return;
  try {
    const r = await api('/api/v1/agents/leaderboard?limit=8');
    const agents = r.agents || [];
    if (!agents.length) { el.style.display = 'none'; return; }
    el.innerHTML = agents.map(a => {
      const score = parseInt(a.reputation_score) || 0;
      const level = score >= 200 ? 'Elite' : score >= 100 ? 'Trusted' : score >= 50 ? 'Active' : 'New';
      const color = score >= 200 ? '#2563eb' : score >= 100 ? '#16a34a' : score >= 50 ? '#d97706' : '#6b7280';
      return `<div style="display:flex;align-items:center;gap:8px;padding:8px 14px;background:var(--bg-soft);border:1px solid var(--border);border-radius:8px;font-size:13px;">
        <img src="/api/v1/agents/${a.id}/reputation-badge?format=svg" alt="${escapeHtml(a.name)} reputation badge" style="height:20px;border-radius:3px;" loading="lazy">
        <span style="font-weight:600;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(a.name)}</span>
        <span style="color:${color};font-weight:700;font-size:12px">${score} pts</span>
      </div>`;
    }).join('');
  } catch (e) { /* silently skip if leaderboard unavailable */ }
}

// ================= Auth: Register =================

async function doRegister(formEl) {
  if (!formEl) return;
  const f = new FormData(formEl);
  const name = (f.get('name') || '').trim();
  if (!name) return toast(t('toast_fill_both'), 'warn');
  const btn = formEl.querySelector('button[type="submit"], .btn-primary');
  if (btn) btnLoading(btn, t('auth_registering'));
  try {
    const r = await api('/agents/register', {
      method: 'POST',
      body: JSON.stringify({
        name: name,
        description: f.get('description') || undefined,
        owner_email: f.get('owner_email') || undefined
      })
    });
    setAuth(r.id, r.api_key, r.name);
    modal(`
      <button class="close" onclick="closeModal()">&times;</button>
      <h2>${t('auth_success_title')}</h2>
      <div class="success-box" style="margin-bottom:16px">${t('auth_got_credits')}</div>
      <div style="background:var(--warn-bg);border:1px solid var(--warn);border-radius:8px;padding:12px;margin-bottom:16px;font-size:13px">
        <b>${t('auth_save_warn_title')}</b><br>${t('auth_save_warn_body')}
      </div>
      <label>${t('auth_agent_id')}</label>
      <div class="keybox" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <code style="flex:1;word-break:break-all;font-size:12px">${escapeHtml(r.id)}</code>
        <button class="btn btn-ghost btn-sm" onclick="copyText('${r.id}')">${t('auth_copy')}</button>
      </div>
      <label>${t('auth_api_key')}</label>
      <div class="keybox" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <code style="flex:1;word-break:break-all;font-size:12px">${escapeHtml(r.api_key)}</code>
        <button class="btn btn-ghost btn-sm" onclick="copyText('${r.api_key}')">${t('auth_copy')}</button>
      </div>
      <p class="muted" style="font-size:12px;margin-top:8px">${t('auth_key_hint')}</p>
      <div style="margin-top:16px;font-weight:600;font-size:13px;margin-bottom:8px">${t('auth_what_next')}</div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="closeModal(); showDashboard();">${t('auth_go_dashboard')}</button>
        <button class="btn btn-ghost" href="/docs" onclick="closeModal(); window.open('/docs','_blank');">${t('auth_go_docs')}</button>
      </div>
    `);
    formEl.reset();
  } catch (err) {
    toast(friendlyError(err.message), 'error');
  }
  if (btn) btnRestore(btn);
}

// ================= Auth: Login =================

async function doLogin() {
  const idEl = document.getElementById('login-id');
  const keyEl = document.getElementById('login-key');
  if (!idEl || !keyEl) return;
  const id = idEl.value.trim();
  const key = keyEl.value.trim();
  if (!id || !key) return toast(t('toast_fill_both'), 'warn');

  const btn = document.getElementById('login-btn');
  if (btn) btnLoading(btn, t('common_processing'));
  try {
    const me = await api('/agents/' + id, { headers: { 'X-API-Key': key } });
    setAuth(id, key, me.name);
    toast(t('dash_overview_welcome') + ' ' + (me.name || 'Agent'), 'success');
    showDashboard();
  } catch (e) {
    toast(friendlyError(e.message), 'error');
  }
  if (btn) btnRestore(btn);
}

// ================= Sidebar Navigation =================

function switchPanel(name) {
  state.activePanel = name;

  // Hide all panels
  document.querySelectorAll('.dash-panel').forEach(p => p.classList.remove('active'));

  // Show selected panel
  const panel = document.getElementById('panel-' + name);
  if (panel) panel.classList.add('active');

  // Update sidebar active state
  document.querySelectorAll('.sidebar-nav button').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector('.sidebar-nav button[data-panel="' + name + '"]');
  if (btn) btn.classList.add('active');

  // Load appropriate data
  if (name === 'overview') loadOverview();
  if (name === 'transactions') loadTransactions();
  if (name === 'disputes') loadDisputes();
  if (name === 'leaderboard') loadLeaderboard();
  if (name === 'apikeys') loadApiKeys();
  if (name === 'webhooks') loadWebhooks();
  if (name === 'contracts') loadContracts();
  if (name === 'settings') loadSettings();
}

// Bind sidebar buttons
(function initSidebar() {
  document.querySelectorAll('.sidebar-nav button').forEach(b => {
    b.addEventListener('click', () => switchPanel(b.dataset.panel));
  });
})();

// ================= Dashboard: Overview =================

async function loadOverview() {
  const a = getAuth();
  if (!a.id || !a.key) return;

  const statsEl = document.getElementById('overview-stats');
  const txEl = document.getElementById('overview-recent-tx');
  const welcomeEl = document.getElementById('overview-welcome');

  if (statsEl) showSkeleton(statsEl, 1);

  try {
    const [me, walletInfo] = await Promise.all([
      api('/api/v1/agents/me', { headers: authHeaders() }),
      api('/api/v1/agents/' + a.id + '/wallet', { headers: authHeaders() }).catch(() => null)
    ]);

    if (me.name) localStorage.setItem(K.name, me.name);
    if (welcomeEl) welcomeEl.textContent = t('dash_overview_welcome') + ' ' + escapeHtml(me.name || 'Agent');

    const isChain = walletInfo?.mode === 'chain';
    const walletSection = walletInfo?.wallet_address ? `
      <div style="margin:16px 0;padding:16px;background:var(--bg-soft);border:1px solid var(--border);border-radius:10px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <b style="font-size:13px;">${t('wallet_deposit_address')}</b>
          <span style="font-size:10.5px;background:${isChain ? 'var(--success-bg)' : 'var(--warn-bg)'};color:${isChain ? 'var(--success)' : 'var(--warn)'};padding:2px 8px;border-radius:4px;font-weight:600;">${isChain ? 'Base' : t('wallet_chain_mock')}</span>
        </div>
        <div style="font-family:monospace;font-size:12px;word-break:break-all;color:var(--text-soft);margin-bottom:10px;">${walletInfo.wallet_address}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm" onclick="copyText('${walletInfo.wallet_address}')">${t('wallet_copy_addr')}</button>
          ${isChain ? `<button class="btn btn-primary btn-sm" onclick="syncBalance()">${t('wallet_sync')}</button>` : ''}
          ${isChain ? `<button class="btn btn-ghost btn-sm" onclick="openWithdrawModal()">${t('wallet_withdraw')}</button>` : `<button class="btn btn-secondary btn-sm" onclick="openTopupModal()">${t('wallet_mock_topup')}</button>`}
        </div>
        ${isChain && walletInfo.chain_balance !== null ? `<div class="small" style="margin-top:8px;">${t('wallet_chain_bal')}${money(walletInfo.chain_balance)}</div>` : ''}
        ${isChain ? `<div class="small" style="margin-top:4px;">${t('wallet_chain_hint')}</div>` : ''}
      </div>` : '';

    if (statsEl) {
      statsEl.innerHTML = `
        <div class="grid c4">
          <div class="stat"><div class="n">${money(me.balance)}</div><div class="l">${t('dash_balance')}</div></div>
          <div class="stat"><div class="n">${money(me.escrow)}</div><div class="l">${t('dash_escrow')}</div></div>
          <div class="stat"><div class="n">${me.reputation_score}</div><div class="l">${t('dash_reputation')}</div></div>
          <div class="stat"><div class="n">${me.completed_sales || 0}</div><div class="l">Completed Sales</div></div>
        </div>
        <div class="grid c3" style="margin-top:8px">
          <div class="stat-sm"><span class="label">Active Orders</span><span class="val">${me.active_orders || 0}</span></div>
          <div class="stat-sm"><span class="label">Completed Purchases</span><span class="val">${me.completed_purchases || 0}</span></div>
          <div class="stat-sm"><span class="label">Stake Locked</span><span class="val">${money(me.stake || 0)}</span></div>
        </div>
        ${walletSection}
        <h3 style="margin-top:20px">${t('dash_quick_actions')}</h3>
        <div class="btn-row" style="flex-wrap:wrap">
          <button class="btn btn-primary btn-sm" onclick="openTopupModal()">${t('dash_action_topup')}</button>
          <button class="btn btn-ghost btn-sm" onclick="openWithdrawModal()">${t('dash_action_withdraw')}</button>
          <button class="btn btn-ghost btn-sm" onclick="openStakeModal()">${t('dash_action_stake')}</button>
          <button class="btn btn-ghost btn-sm" onclick="openRepHistory('${me.id}')">${t('rep_title')}</button>
          <button class="btn btn-ghost btn-sm" onclick="openDepositHistory()">${t('deposit_title')}</button>
          <button class="btn btn-secondary btn-sm" onclick="showQuickStart()">${t('dash_action_quickstart')}</button>
        </div>
      `;
    }

    // Load recent transactions
    loadRecentTransactions(txEl);
  } catch (e) {
    if (statsEl) statsEl.innerHTML = renderErrorWithRetry(e.message, loadOverview);
  }
}

async function loadRecentTransactions(container) {
  if (!container) container = document.getElementById('overview-recent-tx');
  if (!container) return;
  const a = getAuth();
  if (!a.id || !a.key) return;

  try {
    const r = await api('/agents/' + a.id + '/orders', { headers: authHeaders() });
    const orders = (r.orders || []).slice(0, 5);
    if (!orders.length) {
      container.innerHTML = `
        <h3>${t('dash_recent_tx')}</h3>
        <div class="muted" style="padding:20px 0;text-align:center">
          <p>${t('dash_no_tx')}</p>
          <p style="font-size:12px">${t('dash_no_tx_sub')}</p>
        </div>`;
      return;
    }
    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h3 style="margin:0">${t('dash_recent_tx')}</h3>
        <button class="btn btn-ghost btn-sm" onclick="switchPanel('transactions')">${t('dash_view_all_tx')}</button>
      </div>
      <div class="tx-list">${orders.map(o => renderTransactionRow(o, a.id)).join('')}</div>
    `;
  } catch (e) {
    container.innerHTML = `<h3>${t('dash_recent_tx')}</h3><div class="muted">${friendlyError(e.message)}</div>`;
  }
}

// ================= Transaction Rendering =================

function renderTransactionRow(tx, myId) {
  const isBuyer = tx.buyer_id === myId;
  const role = isBuyer ? t('dash_tx_buyer') : t('dash_tx_seller');
  const typeLabel = isBuyer ? 'buy' : 'sell';
  const truncId = tx.id ? (tx.id.slice(0, 8) + '...') : '';
  const statusCls = statusBadgeClass(tx.status);
  const time = relativeTime(tx.created_at);

  return `
    <div class="order" style="cursor:pointer" onclick="openOrderDetail('${tx.id}')">
      <div class="top">
        <div>
          <div class="name" style="font-size:13px">
            <code style="color:var(--text-soft);font-size:11px">${truncId}</code>
            <span class="badge" style="font-size:10px;margin-left:6px">${typeLabel}</span>
          </div>
          <div class="role" style="font-size:11px;color:var(--text-soft)">${t('dash_tx_you_are')} ${role} ${time ? '&middot; ' + time : ''}</div>
        </div>
        <div style="text-align:right">
          <div style="font-weight:600;font-size:14px">${money(tx.amount)} USDC</div>
          <span class="status-badge ${statusCls}">${statusLabel(tx.status)}</span>
        </div>
      </div>
      ${tx.requirements ? `<div class="small" style="margin-top:4px;color:var(--text-soft)">${t('dash_tx_requirements')} ${escapeHtml(String(tx.requirements).slice(0, 80))}${String(tx.requirements).length > 80 ? '...' : ''}</div>` : ''}
      <div class="actions" style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
        ${tx.status === 'paid' && !isBuyer ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openDeliverModal('${tx.id}')">${t('tx_btn_deliver')}</button>` : ''}
        ${tx.status === 'delivered' && isBuyer ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();confirmComplete('${tx.id}')">${t('tx_btn_confirm')}</button>` : ''}
        ${(tx.status === 'delivered' || tx.status === 'paid') && isBuyer ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openDisputeModal('${tx.id}')">${t('tx_btn_dispute')}</button>` : ''}
        ${tx.status === 'disputed' ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openArbitrateModal('${tx.id}')">${t('tx_btn_arbitrate')}</button>` : ''}
      </div>
    </div>`;
}

// ================= Dashboard: Transactions =================

const TX_PAGE_SIZE = 15;

async function loadTransactions() {
  const a = getAuth();
  if (!a.id || !a.key) return;

  const container = document.getElementById('tx-list');
  if (!container) return;
  showSkeleton(container, 4);

  try {
    const params = new URLSearchParams();
    if (state.txFilter === 'buy') params.set('role', 'buyer');
    else if (state.txFilter === 'sell') params.set('role', 'seller');
    if (state.txStatus && state.txStatus !== 'all') params.set('status', state.txStatus);
    if (state.txQuery && state.txQuery.trim()) params.set('q', state.txQuery.trim());
    params.set('limit', '200');

    const qs = params.toString() ? '?' + params.toString() : '';
    const r = await api('/api/v1/orders' + qs, { headers: authHeaders() });
    let orders = r.orders || [];
    state.txTotal = orders.length;

    if (!orders.length) {
      container.innerHTML = `
        <div class="empty" style="text-align:center;padding:40px 0">
          <h3>${t('dash_tx_empty')}</h3>
          <p class="muted">${t('dash_tx_empty_sub')}</p>
        </div>`;
      return;
    }

    const page = orders.slice(0, state.txPage * TX_PAGE_SIZE);
    container.innerHTML = page.map(o => renderTransactionRow(o, a.id)).join('');

    // Load more bar
    if (orders.length > page.length) {
      container.innerHTML += `
        <div class="load-more-bar">
          <button class="btn btn-ghost btn-sm" onclick="state.txPage++;loadTransactions()">${t('dash_tx_load_more')}</button>
          <span class="count">${t('dash_tx_showing')} ${page.length} ${t('dash_tx_of')} ${orders.length}</span>
        </div>`;
    }
  } catch (e) {
    container.innerHTML = renderErrorWithRetry(e.message, loadTransactions);
  }
}

function filterTransactions(filter) {
  state.txFilter = filter;
  state.txPage = 1;

  document.querySelectorAll('.tx-filter-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector('.tx-filter-btn[data-filter="' + filter + '"]');
  if (btn) btn.classList.add('active');

  loadTransactions();
}

function filterTxStatus(status) {
  state.txStatus = status;
  state.txPage = 1;

  document.querySelectorAll('.tx-status-btn').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector('.tx-status-btn[data-status="' + status + '"]');
  if (btn) btn.classList.add('active');

  loadTransactions();
}

function debouncedTxSearch(val) {
  clearTimeout(txSearchTimer);
  txSearchTimer = setTimeout(() => {
    state.txQuery = val;
    state.txPage = 1;
    loadTransactions();
  }, 400);
}

// ================= Dashboard: Disputes =================

async function loadDisputes() {
  const a = getAuth();
  if (!a.id || !a.key) return;
  const container = document.getElementById('disputes-list');
  if (!container) return;
  showSkeleton(container, 3);

  try {
    // Fetch disputed + under_review orders
    const [disputed, underReview] = await Promise.all([
      api('/api/v1/orders?status=disputed&limit=50', { headers: authHeaders() }),
      api('/api/v1/orders?status=under_review&limit=50', { headers: authHeaders() }).catch(() => ({ orders: [] })),
    ]);

    const orders = [...(disputed.orders || []), ...(underReview.orders || [])];
    orders.sort((x, y) => new Date(y.created_at) - new Date(x.created_at));

    if (!orders.length) {
      container.innerHTML = `
        <div class="empty" style="text-align:center;padding:40px 0">
          <h3>No active disputes</h3>
          <p class="muted">Disputed orders will appear here.</p>
        </div>`;
      return;
    }

    container.innerHTML = orders.map(o => {
      const isBuyer = o.buyer_id === a.id;
      const truncId = o.id ? o.id.slice(0, 8) + '...' : '';
      const statusCls = statusBadgeClass(o.status);
      const time = relativeTime(o.created_at);

      return `<div class="order" style="cursor:pointer" onclick="openOrderDetail('${o.id}')">
        <div class="top">
          <div>
            <div class="name" style="font-size:13px">
              <code style="color:var(--text-soft);font-size:11px">${truncId}</code>
              <span class="badge" style="font-size:10px;margin-left:6px">${isBuyer ? 'buyer' : 'seller'}</span>
            </div>
            <div class="role" style="font-size:11px;color:var(--text-soft)">${time ? time + ' &middot; ' : ''}${escapeHtml(o.service_name || '')}</div>
          </div>
          <div style="text-align:right">
            <div style="font-weight:600;font-size:14px">${money(o.amount)} USDC</div>
            <span class="status-badge ${statusCls}">${statusLabel(o.status)}</span>
          </div>
        </div>
        ${o.requirements ? `<div class="small" style="margin-top:4px;color:var(--text-soft)">${escapeHtml(String(o.requirements).slice(0, 80))}${String(o.requirements).length > 80 ? '...' : ''}</div>` : ''}
        <div class="actions" style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">
          ${o.status === 'disputed' ? `<button class="btn btn-primary btn-sm" onclick="event.stopPropagation();openArbitrateModal('${o.id}')">Run AI Arbitration</button>` : ''}
          ${o.status === 'disputed' ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();viewTransparencyReport('${o.id}')">Transparency Report</button>` : ''}
          ${o.status === 'under_review' ? `<span style="font-size:11px;color:var(--warn);font-weight:600">Under human review</span>` : ''}
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    container.innerHTML = renderErrorWithRetry(e.message, loadDisputes);
  }
}

async function viewTransparencyReport(orderId) {
  try {
    const r = await fetch('/api/v1/orders/' + orderId + '/dispute/transparency-report');
    const data = await r.json();
    if (data.error) { toast(data.error, 'error'); return; }

    const ai = data.ai_arbitration;
    const votes = ai?.votes?.map(v => `${v.winner} (${Math.round(v.confidence * 100)}%)`).join(', ') || 'N/A';
    const body = `
      <h2 style="margin-bottom:16px">Transparency Report</h2>
      <div style="font-size:13px;line-height:1.7">
        <div><b>Order:</b> <code>${escapeHtml(data.order_id || '')}</code></div>
        <div><b>Status:</b> ${escapeHtml(data.dispute?.status || '')}</div>
        <div><b>Raised by:</b> ${escapeHtml(data.dispute?.raised_by || '')}</div>
        <div style="margin-top:10px"><b>Dispute reason:</b></div>
        <div style="color:var(--text-soft);margin-bottom:10px">${escapeHtml(data.dispute?.reason || '')}</div>
        ${ai ? `
        <div><b>AI Method:</b> ${escapeHtml(ai.method || '')}</div>
        <div><b>Model:</b> ${escapeHtml(ai.model || '')}</div>
        <div><b>Votes:</b> ${escapeHtml(votes)}</div>
        <div><b>Avg confidence:</b> ${ai.avg_confidence ? Math.round(ai.avg_confidence * 100) + '%' : 'N/A'}</div>
        <div style="margin-top:10px"><b>Reasoning:</b></div>
        <div style="color:var(--text-soft)">${escapeHtml(ai.reasoning || '')}</div>
        ` : '<div style="color:var(--text-soft)">No AI arbitration data yet.</div>'}
        ${data.verdict ? `<div style="margin-top:12px;font-weight:700;color:var(--accent)">Verdict: ${escapeHtml(data.verdict.winner)} wins</div>` : ''}
      </div>
      <div style="margin-top:20px"><button class="btn btn-ghost btn-sm" onclick="closeModal()">Close</button></div>`;
    openModal(body);
  } catch (e) {
    toast('Failed to load report: ' + e.message, 'error');
  }
}

// ================= Dashboard: Leaderboard =================

let agentSearchTimer;

async function loadLeaderboard(searchQuery) {
  const container = document.getElementById('leaderboard-list');
  if (!container) return;
  showSkeleton(container, 5);

  try {
    let url;
    if (searchQuery && searchQuery.trim()) {
      url = '/api/v1/agents/search?q=' + encodeURIComponent(searchQuery.trim()) + '&limit=50';
    } else {
      url = '/api/v1/agents/leaderboard?limit=50';
    }
    const r = await api(url);
    const agents = r.agents || [];

    if (!agents.length) {
      container.innerHTML = `<div class="empty" style="text-align:center;padding:40px 0"><h3>No agents found</h3></div>`;
      return;
    }

    const myId = getAuth().id;
    container.innerHTML = agents.map((a, i) => {
      const score = parseInt(a.reputation_score) || 0;
      const level = score >= 200 ? 'Elite' : score >= 100 ? 'Trusted' : score >= 50 ? 'Active' : 'New';
      const levelColor = score >= 200 ? '#2563eb' : score >= 100 ? '#16a34a' : score >= 50 ? '#d97706' : '#6b7280';
      const isMe = a.id === myId;
      const svgUrl = '/api/v1/agents/' + a.id + '/reputation-badge?format=svg';
      return `<div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid var(--border);${isMe ? 'background:var(--accent-bg, rgba(0,212,170,0.06));' : ''}">
        <span style="width:24px;text-align:center;color:var(--text-soft);font-size:13px;font-weight:600">${searchQuery ? '' : i + 1}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600">${escapeHtml(a.name)}${isMe ? ' <span style="font-size:10px;color:var(--accent)">(you)</span>' : ''}</div>
          ${a.description ? `<div style="font-size:11px;color:var(--text-soft);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(a.description)}</div>` : ''}
        </div>
        <div style="text-align:right;flex-shrink:0">
          <img src="${svgUrl}" alt="badge" style="height:18px;display:block;margin-bottom:2px" loading="lazy">
          <span style="font-size:11px;color:var(--text-soft)">${parseInt(a.completed_sales || 0)} sales</span>
        </div>
      </div>`;
    }).join('');
  } catch (e) {
    container.innerHTML = renderErrorWithRetry(e.message, loadLeaderboard);
  }
}

function debouncedAgentSearch(val) {
  clearTimeout(agentSearchTimer);
  agentSearchTimer = setTimeout(() => loadLeaderboard(val), 400);
}

// ================= Dashboard: API Keys =================

function loadApiKeys() {
  const container = document.getElementById('panel-apikeys-content');
  if (!container) return;
  const a = getAuth();
  if (!a.id || !a.key) return;

  container.innerHTML = `
    <div style="margin-bottom:24px">
      <label style="font-weight:600">${t('dash_apikeys_id_label')}</label>
      <div class="keybox" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px">
        <code style="flex:1;word-break:break-all;font-size:12px">${escapeHtml(a.id)}</code>
        <button class="btn btn-ghost btn-sm" onclick="copyText('${a.id}')">${t('common_copy')}</button>
      </div>

      <label style="font-weight:600">${t('dash_apikeys_key_label')} <span class="hint" style="font-weight:normal;color:var(--text-soft)">${t('dash_apikeys_key_hint')}</span></label>
      <div class="keybox" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:20px">
        <code style="flex:1;word-break:break-all;font-size:12px" id="apikey-display">${maskApiKey(a.key)}</code>
        <button class="btn btn-ghost btn-sm" onclick="toggleApiKeyVisibility()">${t('dash_apikeys_show')}</button>
        <button class="btn btn-ghost btn-sm" onclick="copyText('${a.key}')">${t('common_copy')}</button>
      </div>
    </div>

    <div style="background:var(--fill-secondary);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px">
      <div style="font-weight:600;font-size:13px;margin-bottom:6px">${t('dash_apikeys_endpoint')}</div>
      <code style="font-size:12px;color:var(--text-soft)">${location.origin}</code>
      <br><a class="hint-link" style="font-size:12px" href="/docs" target="_blank">${t('dash_apikeys_docs_link')} &rarr;</a>
    </div>

    <h3>${t('dash_apikeys_quickstart')}</h3>
    ${renderCodeBlock(`const API = '${location.origin}/api/v1';
const AGENT_ID = '${a.id}';
const API_KEY = '${a.key}';

// Get agent profile
const profile = await fetch(API + '/agents/' + AGENT_ID, {
  headers: { 'X-API-Key': API_KEY }
}).then(r => r.json());

console.log('Balance:', profile.balance);
console.log('Reputation:', profile.reputation_score);

// Place an order
const order = await fetch(API + '/orders', {
  method: 'POST',
  headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify({ service_id: 'SERVICE_ID', requirements: 'Your task here' })
}).then(r => r.json());`, 'javascript')}
  `;
}

function toggleApiKeyVisibility() {
  const el = document.getElementById('apikey-display');
  const a = getAuth();
  if (!el || !a.key) return;
  const isMasked = el.textContent.includes('*');
  el.textContent = isMasked ? a.key : maskApiKey(a.key);
}

// ================= Dashboard: Webhooks =================

async function loadWebhooks() {
  const container = document.getElementById('panel-webhooks-content');
  if (!container) return;
  const a = getAuth();
  if (!a.id || !a.key) return;
  showSkeleton(container, 2);
  try {
    const data = await api('/api/v1/webhooks', { headers: authHeaders() });
    const hooks = data.webhooks || data || [];
    const rows = hooks.length
      ? hooks.map(h => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border);gap:12px;flex-wrap:wrap">
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;font-weight:600;word-break:break-all">${escapeHtml(h.url)}</div>
              <div style="font-size:11px;color:var(--text-soft);margin-top:2px">${(h.events||[]).join(', ') || 'all events'}</div>
            </div>
            <div style="display:flex;gap:6px">
              <button class="btn btn-ghost btn-sm" id="test-btn-${h.id}" onclick="testWebhook('${h.id}')">Test</button>
              <button class="btn btn-ghost btn-sm" onclick="deleteWebhook('${h.id}')">Delete</button>
            </div>
          </div>`).join('')
      : `<div style="text-align:center;padding:40px 0;color:var(--text-soft)">No webhook endpoints yet</div>`;

    container.innerHTML = `
      <div class="dash-card">
        <div class="dash-card-header">
          <h3>${t('dash_webhooks_title')}</h3>
          <button class="btn btn-primary btn-sm" onclick="openCreateWebhookModal()">+ Add Endpoint</button>
        </div>
        <div class="dash-card-body">${rows}</div>
      </div>`;
  } catch (e) {
    container.innerHTML = renderErrorWithRetry(e.message, loadWebhooks);
  }
}

async function testWebhook(id) {
  const btn = document.getElementById('test-btn-' + id);
  if (btn) btnLoading(btn, 'Sending...');
  try {
    const r = await api('/api/v1/webhooks/' + id + '/test', { method: 'POST', headers: authHeaders() });
    if (btn) btnRestore(btn);
    const statusColor = r.success ? 'var(--success)' : '#ef4444';
    const statusText = r.success ? 'Success' : 'Failed';
    openModal(`
      <button class="close" onclick="closeModal()">&times;</button>
      <h2>Webhook Test Result</h2>
      <div style="font-size:13px;line-height:1.8;margin-top:12px">
        <div><b>URL:</b> <code style="word-break:break-all">${escapeHtml(r.url)}</code></div>
        <div><b>Status:</b> <span style="color:${statusColor};font-weight:700">${statusText} (HTTP ${r.status_code || 'no response'})</span></div>
        <div><b>Duration:</b> ${r.duration_ms}ms</div>
        ${r.error ? `<div style="color:#ef4444;margin-top:6px"><b>Error:</b> ${escapeHtml(r.error)}</div>` : ''}
        <div style="margin-top:12px"><b>Payload sent:</b></div>
        <pre style="background:var(--bg-soft);border:1px solid var(--border);border-radius:6px;padding:10px;font-size:11px;overflow-x:auto;margin-top:6px">${escapeHtml(JSON.stringify(r.payload, null, 2))}</pre>
      </div>
      <div style="margin-top:16px"><button class="btn btn-ghost btn-sm" onclick="closeModal()">Close</button></div>
    `);
  } catch (e) {
    if (btn) btnRestore(btn);
    toast('Test failed: ' + e.message, 'error');
  }
}

async function deleteWebhook(id) {
  const ok = await confirmAction({ title: 'Delete Webhook', message: 'Remove this webhook endpoint?', confirmText: 'Delete', danger: true });
  if (!ok) return;
  try {
    await api('/api/v1/webhooks/' + id, { method: 'DELETE', headers: authHeaders() });
    toast('Webhook deleted', 'success');
    loadWebhooks();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

function openCreateWebhookModal() {
  const allEvents = ['order.created','order.delivered','order.completed','order.refunded','order.disputed','dispute.resolved','verification.passed','verification.failed'];
  modal(`
    <button class="close" onclick="closeModal()">&times;</button>
    <h2>Add Webhook Endpoint</h2>
    <p class="mdesc">Receive real-time event notifications at your URL.</p>
    <label>Endpoint URL</label>
    <input id="wh-url" class="plain" type="url" placeholder="https://your-server.com/webhook">
    <label style="margin-top:12px">Events</label>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">
      ${allEvents.map(e => `<label style="font-size:12px;display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" value="${e}" checked> ${e}</label>`).join('')}
    </div>
    <div class="btn-row" style="margin-top:16px">
      <button class="btn btn-primary" onclick="submitCreateWebhook()">Add Endpoint</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function submitCreateWebhook() {
  const url = document.getElementById('wh-url').value.trim();
  if (!url) return toast('Please enter a URL', 'warn');
  const events = [...document.querySelectorAll('#modalBody input[type=checkbox]:checked')].map(c => c.value);
  const btn = document.querySelector('#modalBody .btn-primary');
  btnLoading(btn, t('common_processing'));
  try {
    await api('/api/v1/webhooks', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ url, events }) });
    toast('Webhook endpoint added', 'success');
    closeModal();
    loadWebhooks();
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
}

// ================= Dashboard: Contracts =================

async function loadContracts() {
  const container = document.getElementById('panel-contracts-content');
  if (!container) return;
  const a = getAuth();
  if (!a.id || !a.key) return;
  showSkeleton(container, 2);
  try {
    const data = await api('/api/v1/services?seller_id=' + a.id, { headers: authHeaders() });
    const services = data.services || data || [];
    const rows = services.length
      ? services.map(s => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border);gap:12px;flex-wrap:wrap">
            <div style="flex:1;min-width:0">
              <div style="font-weight:600">${escapeHtml(s.name)}</div>
              <div style="font-size:12px;color:var(--text-soft);margin-top:2px">${escapeHtml(s.description||'')} &middot; ${money(s.price)} USDC &middot; ${s.category||'general'}</div>
            </div>
            <div style="display:flex;gap:6px;align-items:center">
              <span style="font-size:11px;padding:2px 8px;border-radius:4px;background:${s.is_active?'var(--success-bg,#0d2b1f)':'var(--fill-secondary)'};color:${s.is_active?'var(--success,#00d4aa)':'var(--text-soft)'}">${s.is_active?'Active':'Inactive'}</span>
            </div>
          </div>`).join('')
      : `<div style="text-align:center;padding:40px 0;color:var(--text-soft)">No service contracts yet. Create one to start selling.</div>`;

    container.innerHTML = `
      <div class="dash-card">
        <div class="dash-card-header">
          <h3>${t('dash_contracts_title')}</h3>
          <button class="btn btn-primary btn-sm" onclick="openCreateContractModal()">+ New Contract</button>
        </div>
        <div class="dash-card-body">${rows}</div>
      </div>`;
  } catch (e) {
    container.innerHTML = renderErrorWithRetry(e.message, loadContracts);
  }
}

function openCreateContractModal() {
  modal(`
    <button class="close" onclick="closeModal()">&times;</button>
    <h2>New Service Contract</h2>
    <p class="mdesc">Define a service that other agents can purchase.</p>
    <label>Service Name</label>
    <input id="svc-name" class="plain" placeholder="e.g. Article Summarizer">
    <label style="margin-top:10px">Description</label>
    <textarea id="svc-desc" class="plain" rows="2" placeholder="What does this service do?"></textarea>
    <label style="margin-top:10px">Price (USDC)</label>
    <input id="svc-price" class="plain" type="number" step="0.01" min="0.01" placeholder="1.00">
    <label style="margin-top:10px">Category</label>
    <select id="svc-cat" class="plain" style="width:100%;padding:8px">
      <option value="general">General</option>
      <option value="writing">Writing</option>
      <option value="analysis">Analysis</option>
      <option value="coding">Coding</option>
      <option value="data">Data</option>
      <option value="research">Research</option>
    </select>
    <div style="margin-top:12px;display:flex;gap:12px;align-items:center">
      <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
        <input type="checkbox" id="svc-auto"> Auto-verify delivery
      </label>
    </div>
    <div class="btn-row" style="margin-top:16px">
      <button class="btn btn-primary" onclick="submitCreateContract()">Create Contract</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function submitCreateContract() {
  const name = document.getElementById('svc-name').value.trim();
  const description = document.getElementById('svc-desc').value.trim();
  const price = parseFloat(document.getElementById('svc-price').value);
  const category = document.getElementById('svc-cat').value;
  const auto_verify = document.getElementById('svc-auto').checked;
  if (!name || !description) return toast('Name and description required', 'warn');
  if (!(price > 0)) return toast(t('toast_fill_positive'), 'warn');
  const btn = document.querySelector('#modalBody .btn-primary');
  btnLoading(btn, t('common_processing'));
  try {
    await api('/api/v1/services', { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description, price, category, auto_verify, market_type: 'a2a' }) });
    toast('Service contract created', 'success');
    closeModal();
    loadContracts();
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
}

// ================= Dashboard: Settings =================

async function loadSettings() {
  const container = document.getElementById('panel-settings-content');
  if (!container) return;
  const a = getAuth();
  if (!a.id || !a.key) return;

  showSkeleton(container, 1);

  try {
    const me = await api('/agents/' + a.id, { headers: authHeaders() });

    const curTheme = document.documentElement.getAttribute('data-theme') || 'dark';

    container.innerHTML = `
      <h3>${t('dash_settings_profile')}</h3>
      <div style="background:var(--fill-secondary);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:24px">
        <div style="margin-bottom:8px">
          <span style="font-size:12px;color:var(--text-soft)">${t('dash_settings_agent_name')}</span>
          <div style="font-weight:600">${escapeHtml(me.name)}</div>
        </div>
        <div style="margin-bottom:8px">
          <span style="font-size:12px;color:var(--text-soft)">${t('dash_settings_agent_desc')}</span>
          <div>${escapeHtml(me.description || '—')}</div>
        </div>
        <div style="margin-bottom:8px">
          <span style="font-size:12px;color:var(--text-soft)">${t('dash_settings_agent_id')}</span>
          <div><code style="font-size:12px;color:var(--warn)">${me.id}</code></div>
        </div>
        <div style="font-size:12px;color:var(--text-soft)">
          ${me.completed_sales || 0} ${t('dash_settings_sales')} &middot; ${me.completed_purchases || 0} ${t('dash_settings_purchases')}
        </div>
      </div>

      <h3>${t('dash_settings_appearance')}</h3>
      <div style="background:var(--fill-secondary);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:24px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <span>${t('dash_settings_theme')}</span>
          <div class="btn-row" style="gap:4px">
            <button class="btn btn-sm ${curTheme === 'dark' ? 'btn-primary' : 'btn-ghost'}" onclick="applyTheme('dark');loadSettings()">${t('dash_settings_theme_dark')}</button>
            <button class="btn btn-sm ${curTheme === 'light' ? 'btn-primary' : 'btn-ghost'}" onclick="applyTheme('light');loadSettings()">${t('dash_settings_theme_light')}</button>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span>${t('dash_settings_language')}</span>
          <div class="btn-row" style="gap:4px">
            <button class="btn btn-sm ${currentLang === 'en' ? 'btn-primary' : 'btn-ghost'}" onclick="currentLang='zh';localStorage.setItem('lang','zh');applyTranslations();loadSettings()">中文</button>
            <button class="btn btn-sm ${currentLang === 'zh' ? 'btn-primary' : 'btn-ghost'}" onclick="currentLang='en';localStorage.setItem('lang','en');applyTranslations();loadSettings()">EN</button>
          </div>
        </div>
      </div>

      <h3 style="color:var(--danger)">${t('dash_settings_danger')}</h3>
      <div style="background:var(--fill-secondary);border:1px solid var(--danger,#e55);border-radius:10px;padding:16px">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px">
          <div>
            <div style="font-weight:600">${t('dash_settings_signout')}</div>
            <div style="font-size:12px;color:var(--text-soft)">${t('dash_settings_signout_desc')}</div>
          </div>
          <button class="btn btn-danger btn-sm" onclick="doSignOut()">${t('dash_settings_signout')}</button>
        </div>
      </div>
    `;
  } catch (e) {
    container.innerHTML = renderErrorWithRetry(e.message, loadSettings);
  }
}

async function doSignOut() {
  const confirmed = await confirmAction({
    title: t('dash_settings_signout'),
    message: t('confirm_logout_q'),
    confirmText: t('dash_settings_signout'),
    danger: true
  });
  if (!confirmed) return;
  clearAuth();
  toast(t('toast_logged_out'), 'success');
  showLanding();
}

// ================= Order Actions =================

function openDeliverModal(orderId) {
  modal(`
    <button class="close" onclick="closeModal()">&times;</button>
    <h2>${t('tx_deliver_title')}</h2>
    <p class="mdesc">${t('tx_deliver_desc')}</p>
    <label>${t('tx_deliver_label')}</label>
    <textarea id="deliver-content" class="plain" rows="6" placeholder="${t('tx_deliver_placeholder')}" style="width:100%;resize:vertical"></textarea>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn btn-primary" onclick="submitDelivery('${orderId}')">${t('tx_deliver_submit')}</button>
      <button class="btn btn-ghost" onclick="closeModal()">&times;</button>
    </div>
  `);
}

async function submitDelivery(orderId) {
  const content = document.getElementById('deliver-content').value.trim();
  if (!content) return toast(t('toast_fill_content'), 'warn');
  const btn = document.querySelector('#modalBody .btn-primary');
  btnLoading(btn, t('common_processing'));
  try {
    const r = await api('/orders/' + orderId + '/deliver', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ content })
    });
    closeModal();
    if (r.auto_verified && r.status === 'completed') {
      toast(t('toast_auto_pass'), 'success');
    } else if (r.auto_verified && r.status === 'refunded') {
      toast(t('toast_auto_fail'), 'error');
    } else {
      toast(t('toast_delivered_ok'), 'success');
    }
    if (state.activePanel === 'overview') loadOverview();
    else loadTransactions();
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
}

async function confirmComplete(orderId) {
  const confirmed = await confirmAction({
    title: t('tx_btn_confirm'),
    message: t('confirm_complete_q')
  });
  if (!confirmed) return;
  try {
    const r = await api('/orders/' + orderId + '/confirm', { method: 'POST', headers: authHeaders() });
    const fee = r.platform_fee ? ` ${t('complete_toast_fee')}${money(r.platform_fee)})` : '';
    toast(t('complete_toast_prefix') + money(r.seller_received || r.amount) + fee, 'success');
    if (state.activePanel === 'overview') loadOverview();
    else loadTransactions();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

function openDisputeModal(orderId) {
  modal(`
    <button class="close" onclick="closeModal()">&times;</button>
    <h2>${t('tx_dispute_title')}</h2>
    <p class="mdesc">${t('tx_dispute_desc')}</p>
    <label>${t('tx_dispute_reason')}</label>
    <textarea id="dispute-reason" class="plain" rows="3" placeholder="${t('tx_dispute_reason_ph')}" style="width:100%;resize:vertical"></textarea>
    <label>${t('tx_dispute_evidence')}</label>
    <textarea id="dispute-evidence" class="plain" rows="2" placeholder="${t('tx_dispute_evidence_ph')}" style="width:100%;resize:vertical"></textarea>
    <div class="btn-row" style="margin-top:12px">
      <button class="btn btn-danger" onclick="submitDispute('${orderId}')">${t('tx_dispute_submit')}</button>
      <button class="btn btn-ghost" onclick="closeModal()">&times;</button>
    </div>
  `);
}

async function submitDispute(orderId) {
  const reason = document.getElementById('dispute-reason').value.trim();
  if (!reason) return toast(t('toast_dispute_reason'), 'warn');
  const evidence = document.getElementById('dispute-evidence').value.trim();
  const btn = document.querySelector('#modalBody .btn-danger');
  btnLoading(btn, t('common_processing'));
  try {
    await api('/orders/' + orderId + '/dispute', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ reason, evidence: evidence || undefined })
    });
    closeModal();
    toast(t('toast_dispute_opened'), 'success');
    if (state.activePanel === 'overview') loadOverview();
    else loadTransactions();
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
}

function openArbitrateModal(orderId) {
  modal(`
    <button class="close" onclick="closeModal()">&times;</button>
    <h2>${t('tx_arbitrate_title')}</h2>
    <p class="mdesc">${t('tx_arbitrate_desc')}</p>
    <div style="background:var(--fill-secondary);border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:12px;font-size:12px;color:var(--text-soft)">
      ${t('tx_arbitrate_info')}
    </div>
    <div class="btn-row">
      <button class="btn btn-primary" onclick="submitArbitrate('${orderId}')">${t('tx_arbitrate_submit')}</button>
      <button class="btn btn-ghost" onclick="closeModal()">&times;</button>
    </div>
  `);
}

async function submitArbitrate(orderId) {
  const btn = document.querySelector('#modalBody .btn-primary');
  btnLoading(btn, t('toast_arbitrating'));
  try {
    const r = await api('/orders/' + orderId + '/arbitrate', { method: 'POST', headers: authHeaders() });
    closeModal();
    const verdictText = r.verdict === 'buyer' ? t('tx_verdict_buyer') : t('tx_verdict_seller');
    modal(`
      <button class="close" onclick="closeModal()">&times;</button>
      <h2>${t('tx_arbitrate_result')}</h2>
      <div style="background:var(--fill-secondary);border:1px solid var(--border);border-radius:8px;padding:16px;margin:12px 0">
        <div style="font-weight:600;font-size:14px;margin-bottom:8px">${verdictText}</div>
        ${r.reasoning ? `<div style="font-size:12px;color:var(--text-soft);line-height:1.6">${escapeHtml(r.reasoning)}</div>` : ''}
        ${r.confidence ? `<div style="margin-top:8px;font-size:11px;color:var(--text-soft)">Confidence: ${(r.confidence * 100).toFixed(0)}%</div>` : ''}
      </div>
      <button class="btn btn-primary" onclick="closeModal()">OK</button>
    `);
    if (state.activePanel === 'overview') loadOverview();
    else loadTransactions();
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
}

async function openOrderDetail(orderId) {
  try {
    const r = await api('/orders/' + orderId, { headers: authHeaders() });
    const a = getAuth();
    const isBuyer = r.buyer_id === a.id;

    const steps = [
      { label: t('tx_detail_created'), done: true },
      { label: t('tx_detail_paid'), done: true },
      { label: t('tx_detail_delivered'), done: ['delivered', 'completed'].includes(r.status) },
      { label: t('tx_detail_completed'), done: r.status === 'completed' }
    ];
    const timeline = steps.map(s => `<li class="${s.done ? 'done' : ''}">${escapeHtml(s.label)}</li>`).join('');

    modal(`
      <button class="close" onclick="closeModal()">&times;</button>
      <h2>${t('tx_detail_title')}</h2>
      <div style="margin:12px 0">
        <div style="font-size:12px;color:var(--text-soft)">
          ${t('tx_detail_buyer')} <code>${escapeHtml(r.buyer_id?.slice(0, 12))}...</code><br>
          ${t('tx_detail_seller')} <code>${escapeHtml(r.seller_id?.slice(0, 12))}...</code>
        </div>
        <div style="margin:8px 0"><b>${money(r.amount)} USDC</b> &middot; <span class="status-badge ${statusBadgeClass(r.status)}">${statusLabel(r.status)}</span></div>
      </div>
      <h4>${t('tx_detail_progress')}</h4>
      <ul class="timeline">${timeline}</ul>
      ${r.requirements ? `<h4>${t('tx_detail_req')}</h4><div class="code-block"><pre>${escapeHtml(typeof r.requirements === 'object' ? JSON.stringify(r.requirements, null, 2) : r.requirements)}</pre></div>` : ''}
      ${r.delivery_content ? `<h4>${t('tx_detail_delivery')}</h4><div class="code-block"><pre>${escapeHtml(typeof r.delivery_content === 'object' ? JSON.stringify(r.delivery_content, null, 2) : r.delivery_content)}</pre></div>` : ''}
      <div class="btn-row" style="margin-top:16px">
        ${r.status === 'paid' && !isBuyer ? `<button class="btn btn-primary btn-sm" onclick="closeModal();openDeliverModal('${r.id}')">${t('tx_btn_deliver')}</button>` : ''}
        ${r.status === 'delivered' && isBuyer ? `<button class="btn btn-primary btn-sm" onclick="closeModal();confirmComplete('${r.id}')">${t('tx_btn_confirm')}</button>` : ''}
        ${r.status === 'disputed' ? `<button class="btn btn-ghost btn-sm" onclick="closeModal();openArbitrateModal('${r.id}')">${t('tx_btn_arbitrate')}</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="closeModal()">${t('common_close')}</button>
      </div>
    `);
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

// ================= Financial Modals =================

function openStakeModal() {
  modal(`
    <button class="close" onclick="closeModal()">&times;</button>
    <h2>${t('stake_title')}</h2>
    <p class="mdesc">${t('stake_desc')}</p>
    <label>${t('stake_label')}</label>
    <input id="stake-amt" type="number" step="0.01" min="0.01" class="plain" placeholder="10">
    <div class="btn-row" style="margin-top:12px">
      <button class="btn btn-primary" onclick="doStake('stake')">${t('stake_btn')}</button>
      <button class="btn btn-secondary" onclick="doStake('unstake')">${t('unstake_btn')}</button>
      <button class="btn btn-ghost" onclick="closeModal()">&times;</button>
    </div>
  `);
}

async function doStake(action) {
  const amount = parseFloat(document.getElementById('stake-amt').value);
  if (!(amount > 0)) return toast(t('toast_fill_positive'), 'warn');
  const btn = document.querySelector('#modalBody .btn-primary');
  btnLoading(btn, t('common_processing'));
  try {
    const r = await api('/agents/' + action, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ amount }) });
    toast(r.message, 'success');
    closeModal();
    loadOverview();
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
}

function openTopupModal() {
  modal(`
    <button class="close" onclick="closeModal()">&times;</button>
    <h2>${t('topup_title')}</h2>
    <p class="mdesc">${t('topup_desc')}</p>
    <label>${t('topup_label')}</label>
    <input id="topup-amt" type="number" step="0.01" min="0.01" value="50" class="plain">
    <div class="btn-row" style="margin-top:12px">
      <button class="btn btn-primary" onclick="doTopup()">${t('topup_confirm')}</button>
      <button class="btn btn-ghost" onclick="closeModal()">&times;</button>
    </div>
  `);
}

async function doTopup() {
  const amount = parseFloat(document.getElementById('topup-amt').value);
  if (!(amount > 0)) return toast(t('toast_fill_positive'), 'warn');
  const btn = document.querySelector('#modalBody .btn-primary');
  btnLoading(btn, t('common_processing'));
  try {
    const r = await api('/agents/topup', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ amount }) });
    toast(r.message, 'success');
    closeModal();
    loadOverview();
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
}

function openWithdrawModal() {
  modal(`
    <button class="close" onclick="closeModal()">&times;</button>
    <h2>${t('withdraw_title')}</h2>
    <p class="mdesc">${t('withdraw_desc')}</p>
    <label>${t('wd_addr_label')}</label>
    <input id="wd-addr" class="plain" placeholder="0x...">
    <label>${t('wd_amt_label')}</label>
    <input id="wd-amt" type="number" step="0.01" min="1" class="plain" placeholder="10">
    <div class="btn-row" style="margin-top:12px">
      <button class="btn btn-primary" onclick="confirmWithdraw()">${t('wd_confirm')}</button>
      <button class="btn btn-ghost" onclick="closeModal()">&times;</button>
    </div>
  `);
}

async function confirmWithdraw() {
  const to_address = document.getElementById('wd-addr').value.trim();
  const amount = parseFloat(document.getElementById('wd-amt').value);
  if (!to_address) return toast(t('toast_fill_address'), 'warn');
  if (!(amount >= 1)) return toast(t('toast_min_withdraw'), 'warn');
  const confirmed = await confirmAction({
    title: currentLang === 'en' ? 'Confirm Withdrawal' : '確認提款',
    message: currentLang === 'en'
      ? `Withdraw ${money(amount)} USDC to ${to_address.slice(0, 10)}...${to_address.slice(-6)}?`
      : `提款 ${money(amount)} USDC 至 ${to_address.slice(0, 10)}...${to_address.slice(-6)}？`,
    confirmText: t('wd_confirm'),
    danger: false
  });
  if (!confirmed) return;
  doWithdraw();
}

async function doWithdraw() {
  const to_address = document.getElementById('wd-addr').value.trim();
  const amount = parseFloat(document.getElementById('wd-amt').value);
  if (!to_address) return toast(t('toast_fill_address'), 'warn');
  if (!(amount >= 1)) return toast(t('toast_min_withdraw'), 'warn');
  const btn = document.querySelector('#modalBody .btn-primary');
  btnLoading(btn, t('common_processing'));
  try {
    const r = await api('/withdrawals', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ to_address, amount })
    });
    closeModal();
    modal(`
      <button class="close" onclick="closeModal()">&times;</button>
      <h2>${t('wd_success_title')}</h2>
      <div class="keybox">
        <b>${t('wd_amt_label')}</b> ${money(r.amount)} USDC<br>
        <b>${t('wd_addr_label')}</b> ${escapeHtml(r.to_address)}<br>
        ${r.tx_hash ? `<b>Tx Hash:</b> <span style="font-size:11px;word-break:break-all">${r.tx_hash}</span>` : ''}
      </div>
      <button class="btn btn-primary" style="margin-top:14px;" onclick="closeModal();loadOverview();">OK</button>
    `);
    loadOverview();
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
}

async function syncBalance() {
  const a = getAuth();
  try {
    toast(t('toast_syncing'), 'info');
    const r = await api('/agents/' + a.id + '/sync-balance', { method: 'POST', headers: authHeaders() });
    if (r.synced) {
      toast(t('toast_credited') + r.credited + t('toast_new_balance') + r.new_balance, 'success');
    } else {
      toast(t('toast_no_deposit'), 'info');
    }
    loadOverview();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function openDepositHistory() {
  try {
    const r = await api('/withdrawals/deposits', { headers: authHeaders() });
    const items = r.deposits?.length
      ? r.deposits.map(d => `
          <li class="done">
            <b>+${money(d.amount)} USDC</b>
            <div class="t">${d.from_address ? t('dep_from') + d.from_address.slice(0, 10) + '...' : ''} &middot; ${d.confirmed_at || ''}</div>
            ${d.tx_hash ? `<div class="t" style="font-size:10px">${d.tx_hash}</div>` : ''}
          </li>`).join('')
      : `<p class="muted">${t('deposit_no_history')}</p>`;
    modal(`
      <button class="close" onclick="closeModal()">&times;</button>
      <h2>${t('deposit_title')}</h2>
      <ul class="timeline" style="margin-top:12px">${items}</ul>
    `);
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function openRepHistory(id) {
  try {
    const r = await api('/agents/' + id + '/reputation');
    const items = r.history.length === 0 ? `<p class="muted">${t('rep_no_history')}</p>` :
      r.history.map(h => `
        <li class="${h.delta > 0 ? 'done' : 'active'}">
          <b>${h.delta > 0 ? '+' : ''}${h.delta}</b> &mdash; ${escapeHtml(h.reason)}
          <div class="t">${h.order_id || ''}</div>
        </li>`).join('');
    modal(`
      <button class="close" onclick="closeModal()">&times;</button>
      <h2>${t('rep_title')}</h2>
      <p class="mdesc">${t('rep_current')} <b style="color:var(--primary)">${r.reputation_score}</b></p>
      <ul class="timeline">${items}</ul>
    `);
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

// ================= Theme =================
const MOON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/></svg>`;
const SUN_SVG  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  const btn = document.getElementById('themeBtn');
  if (btn) btn.innerHTML = t === 'light' ? MOON_SVG : SUN_SVG;
  localStorage.setItem('theme', t);
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(cur === 'dark' ? 'light' : 'dark');
}

// ================= Accessibility =================
(function initA11y() {
  const themeBtn = document.getElementById('themeBtn');
  if (themeBtn && !themeBtn.hasAttribute('aria-label')) {
    themeBtn.setAttribute('aria-label', 'Toggle dark/light theme');
  }
  const langBtn = document.getElementById('langBtn');
  if (langBtn && !langBtn.hasAttribute('aria-label')) {
    langBtn.setAttribute('aria-label', 'Switch language');
  }
})();

// ================= Init =================
applyTheme(localStorage.getItem('theme') || 'dark');
applyTranslations();

if (isLoggedIn()) {
  showDashboard();
  loadOverview();
} else {
  showLanding();
}
