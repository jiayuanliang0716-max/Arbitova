// ================= i18n helpers =================
function t(key) { return (LANG[currentLang] || LANG.en)[key] || (LANG.en)[key] || null; }
function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => { const v = t(el.dataset.i18n); if (v != null) el.textContent = v; });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { const v = t(el.dataset.i18nHtml); if (v != null) el.innerHTML = v; });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { const v = t(el.dataset.i18nPlaceholder); if (v != null) el.placeholder = v; });
  document.documentElement.lang = 'en';
}
function toggleLang() {
  currentLang = currentLang === 'en' ? 'zh' : 'en';
  localStorage.setItem('lang', currentLang);
  applyTranslations();
  if (isLoggedIn()) {
    loadOverview();
  }
}

// ================= Supabase Auth =================
let _supabase = null;
async function initSupabase() {
  if (_supabase) return _supabase;
  if (typeof supabase === 'undefined') return null;
  try {
    const r = await fetch(API + '/api/v1/site-config');
    if (!r.ok) return null;
    const data = await r.json();
    if (data.supabase_url && data.supabase_anon_key) {
      _supabase = supabase.createClient(data.supabase_url, data.supabase_anon_key);
    }
  } catch (e) { /* social auth unavailable */ }
  return _supabase;
}

// ================= State & Storage =================
const API = 'https://api.arbitova.com';
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
        <h3>${escapeHtml(title || 'Are you sure?')}</h3>
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
  modalEl.classList.remove('hidden');
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
  if (modalEl) { modalEl.classList.remove('show'); modalEl.classList.add('hidden'); }
}

// Alias for legacy calls
const openModal = modal;

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
  const fnCall = retryFn.name ? retryFn.name + '()' : '';
  return `<div style="text-align:center;padding:24px;">
    <div style="color:var(--danger,#e55);margin-bottom:12px;font-size:13px">${escapeHtml(friendlyError(message))}</div>
    ${fnCall ? `<button class="btn btn-ghost btn-sm" onclick="${fnCall}">${t('common_retry')}</button>` : ''}
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
  startStatsAutoRefresh();
}

let _unreadPollTimer = null;
async function pollUnreadCount() {
  if (!isLoggedIn()) return;
  try {
    const [dispR, dispR2] = await Promise.all([
      api('/api/v1/orders?status=disputed&limit=50', { headers: authHeaders() }).catch(() => ({ orders: [] })),
      api('/api/v1/orders?status=under_review&limit=50', { headers: authHeaders() }).catch(() => ({ orders: [] })),
    ]);
    const totalDisputes = ((dispR.orders || []).length + (dispR2.orders || []).length);
    const dispBadge = document.getElementById('nav-dispute-badge');
    if (dispBadge) { dispBadge.textContent = totalDisputes; dispBadge.style.display = totalDisputes > 0 ? '' : 'none'; }
    // Update notification bell badge
    const notifBadge = document.getElementById('notif-badge');
    if (notifBadge) {
      if (totalDisputes > 0) { notifBadge.textContent = totalDisputes > 9 ? '9+' : totalDisputes; notifBadge.style.display = ''; }
      else { notifBadge.style.display = 'none'; }
    }
    // Update page title with dispute count
    document.title = totalDisputes > 0
      ? `(${totalDisputes}) Arbitova Dashboard`
      : 'Arbitova — Trust Infrastructure for the Agent Economy';
  } catch (e) { /* silent */ }
}

function showDashboard() {
  const landing = document.getElementById('landing');
  const dashboard = document.getElementById('dashboard');
  if (landing) landing.style.display = 'none';
  if (dashboard) dashboard.style.display = '';
  const hashPanel = window.location.hash.slice(1);
  const validPanels = ['overview','transactions','apikeys','webhooks',
    'disputes','contracts','analytics','wallet','publish','settings'];
  switchPanel((hashPanel && validPanels.includes(hashPanel)) ? hashPanel : 'overview');
  // Poll unread count every 60s while on dashboard
  if (_unreadPollTimer) clearInterval(_unreadPollTimer);
  _unreadPollTimer = setInterval(pollUnreadCount, 60000);
  pollUnreadCount();
}

function animateCount(el, target, prefix, suffix, duration) {
  if (!el) return;
  const start = parseInt(el.dataset.current || '0', 10) || 0;
  if (start === target) return;
  const startTime = performance.now();
  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function tick(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const value = Math.floor(start + (target - start) * easeOut(progress));
    el.textContent = (prefix || '') + value.toLocaleString() + (suffix || '');
    if (progress < 1) requestAnimationFrame(tick);
    else { el.dataset.current = target; }
  }
  requestAnimationFrame(tick);
}

async function loadLandingStats() {
  try {
    const s = await api('/api/v1/platform/stats').catch(() => api('/api/stats'));
    const agents = s.agents_registered || s.agents || 0;
    const orders = s.orders_completed || s.completed_orders || 0;
    const volume = s.total_volume_usdc || s.total_volume || 0;

    animateCount(document.getElementById('ls-agents'), agents, '', '', 900);
    animateCount(document.getElementById('ls-orders'), orders, '', '', 900);

    // Volume: animate as integer, display with $ prefix
    const volEl = document.getElementById('ls-volume');
    if (volEl) {
      const prev = parseInt(volEl.dataset.current || '0', 10);
      const startTime = performance.now();
      function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
      (function tick(now) {
        const p = Math.min((now - startTime) / 900, 1);
        const v = Math.floor(prev + (volume - prev) * easeOut(p));
        volEl.textContent = money(v);
        if (p < 1) requestAnimationFrame(tick);
        else volEl.dataset.current = volume;
      })(performance.now());
    }

    const uptimeEl = document.getElementById('ls-uptime');
    if (uptimeEl) uptimeEl.textContent = '99.9%';

    if (document.getElementById('ls-completion')) {
      const el = document.getElementById('ls-completion');
      animateCount(el, Math.round(s.completion_rate || 0), '', '%', 900);
    }
  } catch (e) { console.error('Stats load error:', e); }
  loadLandingLeaderboard();
  loadLandingVerdicts();
  loadLandingBlogPosts();
}

// Auto-refresh stats every 30 seconds
let _statsInterval;
function startStatsAutoRefresh() {
  if (_statsInterval) return;
  _statsInterval = setInterval(() => {
    if (!isLoggedIn()) loadLandingStats();
  }, 30000);
}

async function loadLandingLeaderboard() {
  const el = document.getElementById('landing-leaderboard');
  if (!el) return;
  try {
    const r = await api('/api/v1/agents/leaderboard?limit=20');
    const agents = (r.agents || []).filter(a =>
      !/seed/i.test(a.name) && !/test/i.test(a.name) && !/demo/i.test(a.name)
    ).slice(0, 8);
    if (!agents.length) { el.style.display = 'none'; return; }
    el.innerHTML = agents.map(a => {
      const score = parseInt(a.reputation_score) || 0;
      const level = score >= 200 ? 'Elite' : score >= 100 ? 'Trusted' : score >= 50 ? 'Active' : 'New';
      const color = score >= 200 ? '#2563eb' : score >= 100 ? '#16a34a' : score >= 50 ? '#d97706' : '#6b7280';
      return `<div style="display:flex;align-items:center;gap:8px;padding:8px 14px;background:var(--bg-soft);border:1px solid var(--border);border-radius:8px;font-size:13px;">
        <img src="${API}/api/v1/agents/${a.id}/reputation-badge?format=svg" alt="${escapeHtml(a.name)} reputation badge" style="height:20px;border-radius:3px;" loading="lazy">
        <span style="font-weight:600;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(a.name)}</span>
        <span style="color:${color};font-weight:700;font-size:12px">${score} pts</span>
      </div>`;
    }).join('');
  } catch (e) { /* silently skip if leaderboard unavailable */ }
}

async function loadLandingVerdicts() {
  const el = document.getElementById('landing-verdicts-feed');
  if (!el) return;
  try {
    const data = await fetch(API + '/api/v1/arbitrate/verdicts?limit=100').then(r => r.json());
    const verdicts = data.verdicts || [];
    if (!verdicts.length) { el.innerHTML = '<div style="grid-column:1/-1;padding:40px;text-align:center;color:var(--text-tertiary);font-size:13px">No verdicts yet. Be the first to use AI arbitration.</div>'; return; }
    const LABELS = {
      incomplete_delivery:'Incomplete Delivery', format_mismatch:'Format Mismatch',
      deadline_violation:'Deadline Violation', quality_dispute:'Quality Dispute',
      missing_sections:'Missing Sections', no_delivery:'No Delivery',
      spec_mismatch:'Spec Mismatch', scope_dispute:'Scope Dispute', general:'General'
    };
    // Fill stats
    const totalEl = document.getElementById('lv-total');
    if (totalEl && data.total) totalEl.textContent = data.total;
    const confs = verdicts.filter(v => v.confidence).map(v => v.confidence);
    const avgConf = confs.length ? confs.reduce((a,b) => a+b, 0) / confs.length : 0;
    const accEl = document.getElementById('lv-accuracy');
    if (accEl && avgConf) accEl.textContent = Math.round(avgConf * 100) + '%';
    // Avg AI arbitration time — delta between raised_at and resolved_at, excluding outliers >600s
    const deltas = verdicts
      .filter(v => v.raised_at && v.resolved_at)
      .map(v => (new Date(v.resolved_at) - new Date(v.raised_at)) / 1000)
      .filter(s => s >= 0 && s <= 600);
    if (deltas.length) {
      const avgSec = deltas.reduce((a,b) => a+b, 0) / deltas.length;
      const label = '~' + (avgSec < 10 ? avgSec.toFixed(1) : Math.round(avgSec)) + 's';
      const avgTopEl = document.getElementById('stats-avg-time');
      if (avgTopEl) avgTopEl.textContent = label;
      const avgLvEl = document.getElementById('lv-avg-time');
      if (avgLvEl) avgLvEl.textContent = label;
    }
    const limitedVerdicts = verdicts.slice(0, 6);

    el.innerHTML = limitedVerdicts.map(v => {
      const winner = v.winner || 'unknown';
      const conf = v.confidence ? Math.round(v.confidence * 100) : null;
      const label = LABELS[v.dispute_type] || v.dispute_type || 'Dispute';
      const date = v.resolved_at ? new Date(v.resolved_at).toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'}) : '';
      const isBuyer = winner === 'buyer';
      const isSeller = winner === 'seller';
      const winBg = isBuyer ? 'rgba(34,197,94,0.08)' : isSeller ? 'rgba(245,158,11,0.08)' : 'var(--bg-raised)';
      const winColor = isBuyer ? 'var(--success)' : isSeller ? 'var(--warning)' : 'var(--text-secondary)';
      const winLabel = isBuyer ? 'Buyer wins' : isSeller ? 'Seller wins' : 'Split';
      const winIcon = isBuyer
        ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>'
        : isSeller
          ? '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="4 18 15 7 20 12"/></svg>'
          : '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg>';
      const confBar = conf ? `<div class="lv-conf-bar"><div class="lv-conf-fill" style="width:${conf}%"></div></div>` : '';
      return `<div class="lv-card" style="border-left:3px solid ${winColor}">
        <div class="lv-card-top">
          <span class="lv-case-num">#${v.case_number || '—'}</span>
          <span class="lv-tag">${escapeHtml(label)}</span>
        </div>
        <div class="lv-reasoning">${escapeHtml((v.reasoning || 'Arbitration decision recorded.').slice(0, 90))}${(v.reasoning || '').length > 90 ? '…' : ''}</div>
        ${confBar}
        <div class="lv-card-bottom">
          <span class="lv-winner-badge" style="background:${winBg};color:${winColor}">${winIcon} ${winLabel}</span>
          ${conf ? `<span class="lv-conf-pct">${conf}% confidence</span>` : ''}
          <span class="lv-date">${date}</span>
        </div>
      </div>`;
    }).join('');
  } catch (e) { /* skip */ }
}

async function loadLandingBlogPosts() {
  const el = document.getElementById('landing-blog-posts');
  if (!el) return;
  try {
    const data = await fetch(API + '/api/v1/posts?limit=3').then(r => r.json());
    const posts = data.posts || [];
    if (!posts.length) {
      el.innerHTML = '<div style="grid-column:1/-1;color:var(--text-tertiary);font-size:13px;text-align:center;padding:32px">No posts yet. Check back soon.</div>';
      return;
    }
    const CAT_COLORS = { changelog:'#3b82f6', update:'#00C896', guide:'#f59e0b', announcement:'#8b5cf6' };
    el.innerHTML = posts.map(p => {
      const catColor = CAT_COLORS[p.category] || '#00C896';
      const date = new Date(p.created_at).toLocaleDateString('en-US', {month:'short', day:'numeric', year:'numeric'});
      return `<a class="blog-prev-card" href="/blog#${escapeHtml(p.slug)}">
        <div class="blog-prev-meta">
          <span class="blog-prev-cat" style="background:${catColor}22;color:${catColor}">${escapeHtml(p.category)}</span>
          <span class="blog-prev-date">${date}</span>
        </div>
        <div class="blog-prev-title">${escapeHtml(p.title)}</div>
        <div class="blog-prev-excerpt">${escapeHtml((p.excerpt || '').slice(0, 100))}${(p.excerpt || '').length > 100 ? '…' : ''}</div>
        <span class="blog-prev-read">Read more &rarr;</span>
      </a>`;
    }).join('');
  } catch (e) { /* skip */ }
}

// ================= Auth: Modals =================

function showRegisterModal() {
  modal(`
    <button class="close" onclick="closeModal()">&times;</button>
    <h2 style="margin:0 0 8px;padding-right:32px">Create your account</h2>
    <p class="mdesc">Sign up in seconds. An agent is created automatically.</p>
    ${socialButtonsHtml()}
    <form onsubmit="event.preventDefault(); doEmailSignup(this)">
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">Email</label>
        <input type="email" name="email" class="form-input" placeholder="you@example.com" required autocomplete="email">
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">Password</label>
        <input type="password" name="password" class="form-input" placeholder="At least 8 characters" minlength="8" required autocomplete="new-password">
      </div>
      <div class="form-group" style="margin-bottom:16px">
        <label class="form-label">Agent name <span style="color:var(--text-tertiary);font-weight:400">(optional)</span></label>
        <input type="text" name="name" class="form-input" placeholder="e.g. MyDataAgent">
      </div>
      <button type="submit" class="btn btn-primary" style="width:100%;margin-top:4px">Create account</button>
    </form>
    <p class="auth-switch">
      Already have an account? <button class="btn btn-ghost btn-sm" onclick="closeModal();showLoginModal()">Sign in</button>
    </p>
  `);
}

function showLoginModal() {
  modal(`
    <button class="close" onclick="closeModal()">&times;</button>
    <h2 style="margin:0 0 8px;padding-right:32px">Sign in</h2>
    <p class="mdesc">Welcome back.</p>
    ${socialButtonsHtml()}
    <form onsubmit="event.preventDefault(); doEmailSignin(this)">
      <div class="form-group" style="margin-bottom:12px">
        <label class="form-label">Email</label>
        <input type="email" name="email" class="form-input" placeholder="you@example.com" required autocomplete="email">
      </div>
      <div class="form-group" style="margin-bottom:16px">
        <label class="form-label">Password</label>
        <input type="password" name="password" class="form-input" placeholder="Your password" required autocomplete="current-password">
      </div>
      <button type="submit" class="btn btn-primary" style="width:100%">Sign in</button>
    </form>
    <details style="margin-top:16px;font-size:12px;color:var(--text-tertiary)">
      <summary style="cursor:pointer;user-select:none">Developer login (Agent ID + API Key)</summary>
      <div style="margin-top:12px">
        <div class="form-group" style="margin-bottom:10px">
          <input type="text" id="login-id" class="form-input" placeholder="agent_..." autocomplete="off">
        </div>
        <div class="form-group" style="margin-bottom:10px">
          <input type="password" id="login-key" class="form-input" placeholder="sk_..." autocomplete="off">
        </div>
        <button id="login-btn" class="btn btn-ghost btn-sm" style="width:100%" onclick="doLogin()">Sign in with API key</button>
      </div>
    </details>
    <p class="auth-switch">
      New here? <button class="btn btn-ghost btn-sm" onclick="closeModal();showRegisterModal()">Create account</button>
    </p>
  `);
}

// ================= Global data-action handler =================
// Handles all [data-action="..."] buttons on the page via event delegation.
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  switch (action) {
    case 'get-api-key':
      if (isLoggedIn()) { showDashboard(); switchPanel('apikeys'); }
      else showRegisterModal();
      break;
    case 'signup':
      if (isLoggedIn()) showDashboard();
      else showRegisterModal();
      break;
    case 'login':
      if (isLoggedIn()) showDashboard();
      else showLoginModal();
      break;
    case 'logout':
      doSignOut();
      break;
    case 'go-dashboard':
      e.preventDefault();
      if (isLoggedIn()) showDashboard();
      else showRegisterModal();
      break;
    case 'toggle-theme':
      toggleTheme();
      break;
    case 'toggle-lang':
      toggleLang();
      break;
  }
});

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

// ================= Email + Password (via Supabase) =================

async function _linkAgentFromSession(session) {
  // Exchange Supabase session for Arbitova agent credentials.
  // Agent display name is pulled from user_metadata.full_name on the backend.
  const r = await api('/api/v1/auth/social', {
    method: 'POST',
    body: JSON.stringify({ access_token: session.access_token }),
  });
  setAuth(r.id, r.api_key, r.name);
  return r;
}

async function doEmailSignup(formEl) {
  if (!formEl) return;
  const sb = await initSupabase();
  if (!sb) { toast('Auth is not configured yet.', 'warn'); return; }
  const f = new FormData(formEl);
  const email = (f.get('email') || '').trim();
  const password = f.get('password') || '';
  const name = (f.get('name') || '').trim();
  if (!email || password.length < 8) { toast('Enter a valid email and 8+ char password.', 'warn'); return; }

  const btn = formEl.querySelector('button[type="submit"]');
  if (btn) btnLoading(btn, 'Creating account...');
  try {
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { data: name ? { full_name: name } : undefined },
    });
    if (error) throw error;

    if (data.session) {
      await _linkAgentFromSession(data.session);
      closeModal();
      toast('Welcome to Arbitova!', 'success');
      showDashboard();
    } else {
      // Email confirmation required
      modal(`
        <button class="close" onclick="closeModal()">&times;</button>
        <h2 style="margin:0 0 8px;padding-right:32px">Check your email</h2>
        <p class="mdesc">We sent a confirmation link to <b>${escapeHtml(email)}</b>. Click it to finish signing up, then come back and sign in.</p>
        <button class="btn btn-primary" style="width:100%;margin-top:8px" onclick="closeModal();showLoginModal()">Go to sign in</button>
      `);
    }
  } catch (e) {
    toast(e.message || 'Sign up failed', 'error');
  } finally {
    if (btn) btnRestore(btn);
  }
}

async function doEmailSignin(formEl) {
  if (!formEl) return;
  const sb = await initSupabase();
  if (!sb) { toast('Auth is not configured yet.', 'warn'); return; }
  const f = new FormData(formEl);
  const email = (f.get('email') || '').trim();
  const password = f.get('password') || '';
  if (!email || !password) { toast('Enter email and password.', 'warn'); return; }

  const btn = formEl.querySelector('button[type="submit"]');
  if (btn) btnLoading(btn, 'Signing in...');
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (!data.session) throw new Error('No session returned');
    await _linkAgentFromSession(data.session);
    closeModal();
    toast('Welcome back!', 'success');
    showDashboard();
  } catch (e) {
    toast(e.message || 'Sign in failed', 'error');
  } finally {
    if (btn) btnRestore(btn);
  }
}

// ================= Social Login =================

async function doSocialLogin(provider) {
  const sb = await initSupabase();
  if (!sb) {
    toast('Social login is not configured yet.', 'warn');
    return;
  }
  try {
    const { data, error } = await sb.auth.signInWithOAuth({
      provider: provider,
      options: {
        redirectTo: window.location.origin + '/?auth_callback=1',
      },
    });
    if (error) throw error;
    // User will be redirected to provider, then back
  } catch (e) {
    toast('Social login failed: ' + (e.message || e), 'error');
  }
}

// Handle OAuth callback — runs on page load
async function handleAuthCallback() {
  // Check for hash fragment from Supabase OAuth redirect
  const hash = window.location.hash;
  const params = new URLSearchParams(window.location.search);
  if (!hash.includes('access_token') && !params.get('auth_callback')) return;

  const sb = await initSupabase();
  if (!sb) return;

  try {
    const { data: { session }, error } = await sb.auth.getSession();
    if (error || !session) return;

    // Exchange Supabase token for Arbitova agent credentials
    const r = await api('/api/v1/auth/social', {
      method: 'POST',
      body: JSON.stringify({ access_token: session.access_token }),
    });

    setAuth(r.id, r.api_key, r.name);

    // Clean URL
    history.replaceState(null, '', window.location.pathname);

    if (r.is_new) {
      modal(`
        <button class="close" onclick="closeModal()">&times;</button>
        <h2>Welcome to Arbitova</h2>
        <div class="success-box" style="margin-bottom:16px">Account created via ${r.provider || 'social login'}. You got 100 test credits.</div>
        <div style="background:var(--warn-bg);border:1px solid var(--warn);border-radius:8px;padding:12px;margin-bottom:16px;font-size:13px">
          <b>Save your API Key</b><br>You will need it for API access. It won't be shown again.
        </div>
        <label>Agent ID</label>
        <div class="keybox" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <code style="flex:1;word-break:break-all;font-size:12px">${escapeHtml(r.id)}</code>
          <button class="btn btn-ghost btn-sm" onclick="copyText('${r.id}')">Copy</button>
        </div>
        <label>API Key</label>
        <div class="keybox" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
          <code style="flex:1;word-break:break-all;font-size:12px">${escapeHtml(r.api_key)}</code>
          <button class="btn btn-ghost btn-sm" onclick="copyText('${r.api_key}')">Copy</button>
        </div>
        <div style="margin-top:16px">
          <button class="btn btn-primary" onclick="closeModal(); showDashboard();">Go to Dashboard</button>
        </div>
      `);
    } else {
      toast('Welcome back, ' + (r.name || 'Agent') + '!', 'success');
      showDashboard();
    }
  } catch (e) {
    console.error('Social auth callback error:', e);
    toast('Login failed: ' + (e.message || e), 'error');
  }
}

function socialButtonsHtml() {
  return `
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px">
      <button class="btn-social" onclick="doSocialLogin('google')">
        <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59a14.5 14.5 0 0 1 0-9.18l-7.98-6.19a24.01 24.01 0 0 0 0 21.56l7.98-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
        Continue with Google
      </button>
      <button class="btn-social" onclick="doSocialLogin('github')">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
        Continue with GitHub
      </button>
    </div>
    <div class="auth-divider">
      <hr>
      <span>or use email</span>
      <hr>
    </div>
  `;
}

// ================= Sidebar Navigation =================

function switchPanel(name) {
  state.activePanel = name;

  // Update URL hash for bookmarkable panels
  if (history.replaceState) {
    history.replaceState(null, '', '#' + name);
  }

  // Update page title
  const titles = {
    overview: 'Overview', transactions: 'Transactions', apikeys: 'API Keys', webhooks: 'Webhooks',
    disputes: 'Disputes', contracts: 'Contracts', analytics: 'Analytics',
    wallet: 'Balance & Escrow', publish: 'Publish', settings: 'Settings'
  };
  document.title = (titles[name] || name) + ' — Arbitova';

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
  if (name === 'apikeys') loadApiKeys();
  if (name === 'webhooks') loadWebhooks();
  if (name === 'contracts') loadContracts();
  if (name === 'analytics') loadAnalytics();
  if (name === 'wallet') loadWallet();
  if (name === 'settings') loadSettings();
  if (name === 'publish') loadPublish();
}

// Bind sidebar buttons
(function initSidebar() {
  document.querySelectorAll('.sidebar-nav button').forEach(b => {
    b.addEventListener('click', () => switchPanel(b.dataset.panel));
  });
})();

// ================= Onboarding Checklist =================

function renderOnboardingChecklist(me, orderStats, apiKeys) {
  const dismissed = localStorage.getItem('arb_onboarding_done');
  if (dismissed) return '';

  const totalOrders = orderStats?.total || me.active_orders || 0;
  const hasApiKey = apiKeys && apiKeys.length > 0;
  const hasTransaction = totalOrders > 0;

  // Hide checklist if all steps done
  if (hasApiKey && hasTransaction) {
    localStorage.setItem('arb_onboarding_done', '1');
    return '';
  }

  const step = (done, label, action, actionLabel) => `
    <div style="display:flex;align-items:center;gap:12px;padding:10px 0;border-bottom:1px solid var(--border-subtle)">
      <div style="width:22px;height:22px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;
        background:${done ? 'var(--brand-dim)' : 'var(--bg-raised)'};
        border:1.5px solid ${done ? 'var(--brand)' : 'var(--border-strong)'};
        color:${done ? 'var(--brand)' : 'var(--text-tertiary)'}">
        ${done ? '&#10003;' : ''}
      </div>
      <span style="flex:1;font-size:13px;color:${done ? 'var(--text-tertiary)' : 'var(--text)'};
        text-decoration:${done ? 'line-through' : 'none'}">${label}</span>
      ${!done ? `<button class="btn btn-ghost btn-sm" onclick="${action}" style="font-size:12px">${actionLabel}</button>` : ''}
    </div>`;

  return `
    <div id="onboarding-checklist" style="margin-bottom:16px;background:var(--bg-surface);border:1px solid var(--brand-border);border-radius:var(--radius-lg);padding:16px 20px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div>
          <div style="font-weight:700;font-size:14px;color:var(--text)">Get Started with Arbitova</div>
          <div style="font-size:12px;color:var(--text-secondary);margin-top:2px">Complete these steps to start transacting</div>
        </div>
        <button onclick="document.getElementById('onboarding-checklist').remove();localStorage.setItem('arb_onboarding_done','1')"
          style="background:none;border:none;cursor:pointer;color:var(--text-tertiary);font-size:18px;line-height:1;padding:4px" aria-label="Dismiss">&#215;</button>
      </div>
      ${step(true, 'Create your agent account', '', '')}
      ${step(hasApiKey, 'Generate your first API key', "switchPanel('apikeys')", 'Go to API Keys &rarr;')}
      ${step(hasTransaction, 'Complete your first transaction', "switchPanel('transactions')", 'View Transactions &rarr;')}
    </div>`;
}

// ================= Dashboard: Overview =================

async function loadOverview() {
  const a = getAuth();
  if (!a.id || !a.key) return;

  const statsEl = document.getElementById('overview-stats');
  const txEl = document.getElementById('overview-recent-tx');
  const welcomeEl = document.getElementById('overview-welcome');

  if (statsEl) showSkeleton(statsEl, 1);

  try {
    const [me, walletInfo, pendingSellerOrders, orderStats, apiKeysResp] = await Promise.all([
      api('/api/v1/agents/me', { headers: authHeaders() }),
      api('/api/v1/agents/' + a.id + '/wallet', { headers: authHeaders() }).catch(() => null),
      api('/api/v1/orders?role=seller&status=paid&limit=50', { headers: authHeaders() }).catch(() => ({ orders: [] })),
      api('/api/v1/orders/stats', { headers: authHeaders() }).catch(() => null),
      api('/api/v1/apikeys', { headers: authHeaders() }).catch(() => ({ keys: [] })),
    ]);

    if (me.name) localStorage.setItem(K.name, me.name);
    if (welcomeEl) welcomeEl.textContent = t('dash_overview_welcome') + ' ' + escapeHtml(me.name || 'Agent');

    // Update sidebar agent info
    const sidebarInfo = document.getElementById('sidebar-agent-info');
    const sidebarName = document.getElementById('sidebar-agent-name');
    const sidebarLevel = document.getElementById('sidebar-agent-level');
    const sidebarScore = document.getElementById('sidebar-agent-score');
    if (sidebarInfo && me.name) {
      const score = parseInt(me.reputation_score) || 0;
      const level = score >= 200 ? 'Elite' : score >= 100 ? 'Trusted' : score >= 50 ? 'Active' : 'New';
      const levelColor = score >= 200 ? 'var(--brand)' : score >= 100 ? 'var(--success)' : score >= 50 ? 'var(--warning)' : 'var(--text-tertiary)';
      if (sidebarName) sidebarName.textContent = me.name;
      if (sidebarLevel) { sidebarLevel.textContent = level; sidebarLevel.style.color = levelColor; }
      if (sidebarScore) sidebarScore.textContent = score + ' pts';
      sidebarInfo.style.display = '';
    }

    const walletSection = '';

    if (statsEl) {
      const totalOrders = orderStats?.total || 0;
      const completedOrders = orderStats?.completed || me.completed_sales || 0;
      const disputedOrders = orderStats?.disputed || 0;
      const disputeRate = totalOrders > 0 ? ((disputedOrders / totalOrders) * 100).toFixed(1) + '%' : '—';
      const pendingDelivery = (pendingSellerOrders.orders || []).length;
      const apiKeyCount = (apiKeysResp?.keys || []).length;

      statsEl.innerHTML = renderOnboardingChecklist(me, orderStats, apiKeysResp?.keys) + `
        <div class="grid c4">
          <div class="stat">
            <div class="n">${totalOrders}</div>
            <div class="l">Total Orders</div>
          </div>
          <div class="stat">
            <div class="n">${money(me.escrow)}</div>
            <div class="l">In Escrow</div>
          </div>
          <div class="stat">
            <div class="n" style="${disputedOrders > 0 ? 'color:var(--danger,#ef4444)' : ''}">${disputeRate}</div>
            <div class="l">Dispute Rate</div>
          </div>
          <div class="stat">
            <div class="n">${apiKeyCount}</div>
            <div class="l">Active API Keys</div>
          </div>
        </div>
        <div class="grid c4" style="margin-top:8px">
          <div class="stat-sm"><span class="label">Available Balance</span><span class="val">${money(me.balance)}</span></div>
          <div class="stat-sm"><span class="label">Completed</span><span class="val">${completedOrders}</span></div>
          <div class="stat-sm"><span class="label">Pending Delivery</span><span class="val ${pendingDelivery > 0 ? 'val-accent' : ''}" style="${pendingDelivery > 0 ? 'color:var(--accent);font-weight:700' : ''}">${pendingDelivery}</span></div>
          <div class="stat-sm"><span class="label">Disputes Open</span><span class="val ${disputedOrders > 0 ? '' : ''}" style="${disputedOrders > 0 ? 'color:var(--danger,#ef4444);font-weight:700' : ''}">${disputedOrders}</span></div>
        </div>
        ${pendingDelivery > 0 ? `
        <div style="margin-top:12px;padding:10px 14px;background:rgba(0,212,170,0.07);border:1px solid var(--accent);border-radius:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px">
          <div style="font-size:13px;font-weight:600;color:var(--accent)">${pendingDelivery} order${pendingDelivery > 1 ? 's' : ''} pending delivery</div>
          <button class="btn btn-primary btn-sm" onclick="switchPanel('transactions')">View Orders</button>
        </div>` : ''}
        <div class="btn-row" style="flex-wrap:wrap;margin-top:16px">
          <button class="btn btn-ghost btn-sm" onclick="switchPanel('transactions')">Transactions</button>
          <button class="btn btn-ghost btn-sm" onclick="switchPanel('disputes')">Disputes</button>
          <button class="btn btn-ghost btn-sm" onclick="switchPanel('wallet')">Balance &amp; Escrow</button>
          <button class="btn btn-ghost btn-sm" onclick="switchPanel('apikeys')">API Keys</button>
          <button class="btn btn-secondary btn-sm" onclick="showQuickStart()">Quick Start</button>
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

async function exportTransactions(format = 'csv') {
  const a = getAuth();
  if (!a.id || !a.key) return;
  try {
    const params = new URLSearchParams();
    if (state.txFilter === 'buy') params.set('role', 'buyer');
    else if (state.txFilter === 'sell') params.set('role', 'seller');
    if (state.txStatus && state.txStatus !== 'all') params.set('status', state.txStatus);
    if (state.txQuery && state.txQuery.trim()) params.set('q', state.txQuery.trim());
    params.set('limit', '1000');
    const qs = params.toString() ? '?' + params.toString() : '';
    const r = await api('/api/v1/orders' + qs, { headers: authHeaders() });
    const orders = r.orders || [];
    if (!orders.length) { toast('No orders to export', 'info'); return; }

    if (format === 'json') {
      const blob = new Blob([JSON.stringify(orders, null, 2)], { type: 'application/json' });
      downloadBlob(blob, 'arbitova-orders.json');
    } else {
      const cols = ['id', 'status', 'amount', 'platform_fee', 'role', 'service_name', 'created_at', 'completed_at'];
      const rows = orders.map(o => {
        const role = o.buyer_id === a.id ? 'buyer' : 'seller';
        return cols.map(c => {
          const v = c === 'role' ? role : (o[c] ?? '');
          return '"' + String(v).replace(/"/g, '""') + '"';
        }).join(',');
      });
      const csv = [cols.join(','), ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv' });
      downloadBlob(blob, 'arbitova-orders.csv');
    }
    toast('Export downloaded', 'success');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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

    // Update disputes sidebar badge
    const dispBadge = document.getElementById('nav-dispute-badge');
    if (dispBadge) {
      dispBadge.textContent = orders.length;
      dispBadge.style.display = orders.length > 0 ? '' : 'none';
    }

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
    const r = await fetch(API + '/api/v1/orders/' + orderId + '/dispute/transparency-report');
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

    <div style="margin-top:24px;background:var(--bg-surface);border:1px solid var(--border-default);border-radius:var(--radius-lg);overflow:hidden">
      <div style="padding:14px 16px;border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;justify-content:space-between">
        <div style="font-weight:600;font-size:13px">Quick API Test</div>
        <span style="font-size:11px;color:var(--text-tertiary)">Live call to api.arbitova.com</span>
      </div>
      <div style="padding:16px">
        <div style="display:flex;gap:8px;margin-bottom:12px;align-items:center">
          <select id="api-playground-method" style="padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-raised);color:var(--text);font-size:12px;font-weight:600;width:80px">
            <option>GET</option>
          </select>
          <select id="api-playground-endpoint" onchange="apiPlaygroundEndpointChange()" style="flex:1;padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-raised);color:var(--text);font-size:12px">
            <option value="/api/v1/agents/me">GET /agents/me — Your profile</option>
            <option value="/api/v1/orders/stats">GET /orders/stats — Order statistics</option>
            <option value="/api/v1/orders?limit=5">GET /orders — Recent orders</option>
            <option value="/api/v1/webhooks">GET /webhooks — Your webhooks</option>
          </select>
          <button class="btn btn-primary btn-sm" onclick="runApiPlayground('${escapeHtml(a.key)}')">Run</button>
        </div>
        <div id="api-playground-result" style="font-family:var(--font-mono);font-size:11px;line-height:1.7;background:var(--bg-base);border:1px solid var(--border-subtle);border-radius:6px;padding:12px;min-height:60px;max-height:200px;overflow-y:auto;color:var(--text-secondary);white-space:pre-wrap">
          Click Run to execute this API call with your key.
        </div>
      </div>
    </div>
  `;
}

async function runApiPlayground(apiKey) {
  const resultEl = document.getElementById('api-playground-result');
  const endpointEl = document.getElementById('api-playground-endpoint');
  if (!resultEl || !endpointEl) return;
  const endpoint = endpointEl.value;
  resultEl.textContent = 'Loading...';
  resultEl.style.color = 'var(--text-secondary)';
  try {
    const res = await fetch('https://api.arbitova.com' + endpoint, {
      headers: { 'X-API-Key': apiKey }
    });
    const data = await res.json().catch(() => ({}));
    resultEl.textContent = JSON.stringify(data, null, 2);
    resultEl.style.color = res.ok ? 'var(--success)' : '#ef4444';
  } catch (e) {
    resultEl.textContent = 'Error: ' + e.message;
    resultEl.style.color = '#ef4444';
  }
}

function apiPlaygroundEndpointChange() {
  const resultEl = document.getElementById('api-playground-result');
  if (resultEl) {
    resultEl.textContent = 'Click Run to execute this API call with your key.';
    resultEl.style.color = 'var(--text-secondary)';
  }
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
    const [data, logsData] = await Promise.all([
      api('/api/v1/webhooks', { headers: authHeaders() }),
      api('/api/v1/webhooks/logs?limit=20', { headers: authHeaders() }).catch(() => null),
    ]);
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

    // Delivery log section
    const logs = logsData?.logs || [];
    const logRows = logs.length
      ? logs.map(log => {
          const ok = log.status_code >= 200 && log.status_code < 300;
          const statusColor = ok ? 'var(--success)' : '#ef4444';
          const dot = ok ? '&#10003;' : '&#10005;';
          return `
            <div style="display:grid;grid-template-columns:20px 1fr auto auto;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--border-subtle);font-size:12px">
              <span style="color:${statusColor};font-weight:700">${dot}</span>
              <span style="color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(log.event_type || 'unknown')}</span>
              <span style="color:${statusColor};font-family:var(--font-mono);font-weight:600">${log.status_code ? 'HTTP ' + log.status_code : 'timeout'}</span>
              <span style="color:var(--text-tertiary);white-space:nowrap">${relativeTime(log.created_at)}</span>
            </div>`;
        }).join('')
      : `<div style="text-align:center;padding:24px;color:var(--text-tertiary);font-size:12px">No delivery logs yet — send a test to see events here</div>`;

    const logSection = logsData !== null ? `
      <div class="dash-card" style="margin-top:16px">
        <div class="dash-card-header">
          <h3>Recent Delivery Log</h3>
          <button class="btn btn-ghost btn-sm" onclick="loadWebhooks()">Refresh</button>
        </div>
        <div class="dash-card-body" style="padding:0 16px">${logRows}</div>
      </div>` : '';

    container.innerHTML = `
      <div class="dash-card">
        <div class="dash-card-header">
          <h3>${t('dash_webhooks_title')}</h3>
          <button class="btn btn-primary btn-sm" onclick="openCreateWebhookModal()">+ Add Endpoint</button>
        </div>
        <div class="dash-card-body">${rows}</div>
      </div>
      ${logSection}`;
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
    const data = await api('/api/v1/agents/me/services', { headers: authHeaders() });
    const services = data.services || data || [];
    const rows = services.length
      ? services.map(s => `
          <div style="display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid var(--border);gap:12px;flex-wrap:wrap">
            <div style="flex:1;min-width:0">
              <div style="font-weight:600">${escapeHtml(s.name)}</div>
              <div style="font-size:12px;color:var(--text-soft);margin-top:2px">${escapeHtml(s.description||'')} &middot; ${money(s.price)} USDC &middot; ${s.category||'general'}</div>
              <div style="font-size:11px;color:var(--text-soft);margin-top:2px;font-family:monospace">${s.id} &middot; ${s.completed_orders||0}/${s.total_orders||0} orders completed</div>
            </div>
            <div style="display:flex;gap:6px;align-items:center">
              <span style="font-size:11px;padding:2px 8px;border-radius:4px;background:${s.is_active?'var(--success-bg,#0d2b1f)':'var(--fill-secondary)'};color:${s.is_active?'var(--success,#00d4aa)':'var(--text-soft)'}">${s.is_active?'Active':'Inactive'}</span>
              <button class="btn btn-ghost btn-sm" onclick="toggleServiceActive('${s.id}',${!s.is_active})">${s.is_active ? 'Disable' : 'Enable'}</button>
              <button class="btn btn-ghost btn-sm" onclick="openEditServiceModal('${s.id}','${escapeHtml(s.name)}','${escapeHtml(s.description||'')}',${s.price},'${s.category||'general'}')">Edit</button>
              <button class="btn btn-ghost btn-sm" onclick="cloneService('${s.id}','${escapeHtml(s.name)}')">Clone</button>
              <button class="btn btn-ghost btn-sm" style="color:var(--danger,#ef4444)" onclick="deleteService('${s.id}','${escapeHtml(s.name)}')">Delete</button>
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

async function toggleServiceActive(serviceId, newActive) {
  try {
    await api('/api/v1/services/' + serviceId, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: newActive }),
    });
    toast(newActive ? 'Service enabled' : 'Service disabled', 'success');
    loadContracts();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function deleteService(serviceId, serviceName) {
  const confirmed = await confirmAction({
    title: 'Delete Service',
    message: `Delete "${serviceName}"? This cannot be undone. Services with active orders cannot be deleted.`,
    confirmText: 'Delete',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api('/api/v1/services/' + serviceId, { method: 'DELETE', headers: authHeaders() });
    toast('Service deleted', 'success');
    loadContracts();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function cloneService(serviceId, serviceName) {
  try {
    const r = await api('/api/v1/services/' + serviceId + '/clone', { method: 'POST', headers: authHeaders(), body: JSON.stringify({}) });
    toast(r.message || 'Service cloned. Edit and activate when ready.', 'success');
    loadContracts();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

function openEditServiceModal(serviceId, name, description, price, category) {
  modal(`
    <button class="close" onclick="closeModal()">&times;</button>
    <h2>Edit Service</h2>
    <label>Name</label>
    <input id="edit-svc-name" class="plain" value="${escapeHtml(name)}">
    <label style="margin-top:10px">Description</label>
    <textarea id="edit-svc-desc" class="plain" rows="2">${escapeHtml(description)}</textarea>
    <label style="margin-top:10px">Price (USDC)</label>
    <input id="edit-svc-price" class="plain" type="number" step="0.01" min="0.01" value="${price}">
    <label style="margin-top:10px">Category</label>
    <select id="edit-svc-cat" class="plain" style="width:100%;padding:8px">
      ${['general','writing','analysis','coding','data','research'].map(c =>
        `<option value="${c}"${c === category ? ' selected' : ''}>${c.charAt(0).toUpperCase()+c.slice(1)}</option>`
      ).join('')}
    </select>
    <div class="btn-row" style="margin-top:16px">
      <button class="btn btn-primary" onclick="submitEditService('${serviceId}',this)">Save Changes</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function submitEditService(serviceId, btn) {
  const name = document.getElementById('edit-svc-name').value.trim();
  const description = document.getElementById('edit-svc-desc').value.trim();
  const price = parseFloat(document.getElementById('edit-svc-price').value);
  const category = document.getElementById('edit-svc-cat').value;
  if (!name) return toast('Name is required', 'warn');
  if (!(price > 0)) return toast(t('toast_fill_positive'), 'warn');
  btnLoading(btn, 'Saving...');
  try {
    await api('/api/v1/services/' + serviceId, {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, price, category }),
    });
    toast('Service updated', 'success');
    closeModal();
    loadContracts();
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
}

// ================= Dashboard: Analytics =================

async function loadAnalytics() {
  const container = document.getElementById('panel-analytics-content');
  if (!container) return;
  showSkeleton(container, 3);

  try {
    const [data, sellerData] = await Promise.all([
      api('/api/v1/analytics', { headers: authHeaders() }),
      api('/api/v1/agents/me/analytics', { headers: authHeaders() }).catch(() => null),
    ]);
    const daily = data.as_seller?.daily_revenue || [];
    const top = data.as_seller?.top_services || [];
    const buyer = data.as_buyer || {};

    // Build mini bar chart (pure CSS/HTML, no library)
    const maxRevenue = daily.length > 0 ? Math.max(...daily.map(d => d.revenue), 0.01) : 1;
    const chartHtml = daily.length > 0 ? `
      <div style="display:flex;align-items:flex-end;gap:3px;height:80px;margin:16px 0 4px">
        ${daily.map(d => {
          const h = Math.max(Math.round((d.revenue / maxRevenue) * 72), d.revenue > 0 ? 4 : 0);
          return `<div title="${d.day}: ${money(d.revenue)} USDC (${d.orders} orders)"
            style="flex:1;background:var(--accent);opacity:0.8;border-radius:2px 2px 0 0;height:${h}px;min-width:4px;cursor:pointer;transition:opacity 0.15s"
            onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=0.8"></div>`;
        }).join('')}
      </div>
      <div style="font-size:10px;color:var(--text-soft);display:flex;justify-content:space-between;margin-bottom:16px">
        <span>${daily[0]?.day ? new Date(daily[0].day).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : ''}</span>
        <span>${daily[daily.length-1]?.day ? new Date(daily[daily.length-1].day).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : ''}</span>
      </div>` : `<div style="text-align:center;padding:24px 0;color:var(--text-soft);font-size:13px">No revenue in last 30 days yet.</div>`;

    const totalRevenue30 = daily.reduce((s, d) => s + d.revenue, 0);
    const totalOrders30 = daily.reduce((s, d) => s + d.orders, 0);

    // Seller detailed section
    let sellerSection = '';
    if (sellerData) {
      const summary = sellerData.summary || {};
      const byCategory = sellerData.by_category || [];
      const topBuyers = sellerData.top_buyers || [];
      const services = sellerData.services || [];

      const categoryHtml = byCategory.length > 0 ? byCategory.map(c => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <div style="flex:1;font-size:12px">${escapeHtml(c.category)}</div>
          <div style="font-size:12px;color:var(--text-soft)">${c.order_count} orders</div>
          <div style="font-size:12px;font-weight:600;min-width:80px;text-align:right">${money(c.net_revenue)} USDC</div>
        </div>`).join('') : '<div style="color:var(--text-soft);font-size:12px">No category data yet.</div>';

      const buyersHtml = topBuyers.length > 0 ? topBuyers.map((b, i) => `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <div style="font-size:11px;color:var(--text-soft);min-width:16px">${i+1}.</div>
          <div style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(b.name)}</div>
          <div style="font-size:12px;color:var(--text-soft)">${b.order_count}x</div>
          <div style="font-size:12px;font-weight:600;min-width:70px;text-align:right">${money(b.total_spent)} USDC</div>
        </div>`).join('') : '<div style="color:var(--text-soft);font-size:12px">No buyer data yet.</div>';

      const serviceTableHtml = services.length > 0 ? `
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="color:var(--text-soft);border-bottom:1px solid var(--border)">
            <th style="text-align:left;padding:4px 0">Service</th>
            <th style="text-align:right;padding:4px 4px">Orders</th>
            <th style="text-align:right;padding:4px 0">Revenue</th>
          </tr></thead>
          <tbody>${services.map(s => `<tr style="border-bottom:1px solid var(--border)">
            <td style="padding:5px 0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px">${escapeHtml(s.name)}</td>
            <td style="text-align:right;padding:5px 4px">${s.completed}/${s.total_orders}</td>
            <td style="text-align:right;padding:5px 0;font-weight:600">${money(s.revenue)}</td>
          </tr>`).join('')}</tbody>
        </table>` : '<div style="color:var(--text-soft);font-size:12px">No services yet.</div>';

      sellerSection = `
        <div class="dash-card" style="margin-top:16px">
          <div class="dash-card-header"><h3>Seller Performance (All Time)</h3></div>
          <div class="dash-card-body">
            <div class="grid c4" style="margin-bottom:16px">
              <div class="stat"><div class="n">${money(summary.net_revenue || 0)}</div><div class="l">Net Revenue</div></div>
              <div class="stat"><div class="n">${summary.completed_orders || 0}</div><div class="l">Completed</div></div>
              <div class="stat"><div class="n">${summary.completion_rate || 0}%</div><div class="l">Completion Rate</div></div>
              <div class="stat"><div class="n">${summary.disputed_orders || 0}</div><div class="l">Disputes</div></div>
            </div>
            <h4 style="margin:0 0 8px;font-size:13px">By Category</h4>
            ${categoryHtml}
            <h4 style="margin:16px 0 8px;font-size:13px">Top Buyers</h4>
            ${buyersHtml}
            <h4 style="margin:16px 0 8px;font-size:13px">Service Breakdown</h4>
            ${serviceTableHtml}
          </div>
        </div>`;
    }

    container.innerHTML = `
      <div class="dash-card">
        <div class="dash-card-header"><h3>Analytics (Last 30 Days)</h3></div>
        <div class="dash-card-body">
          <div class="grid c4" style="margin-bottom:16px">
            <div class="stat"><div class="n">${money(totalRevenue30)}</div><div class="l">Revenue (30d)</div></div>
            <div class="stat"><div class="n">${totalOrders30}</div><div class="l">Orders Sold</div></div>
            <div class="stat"><div class="n">${buyer.orders_placed || 0}</div><div class="l">Orders Bought</div></div>
            <div class="stat"><div class="n">${money(buyer.total_spent || 0)}</div><div class="l">Total Spent</div></div>
          </div>
          <h4 style="margin:0 0 4px;font-size:13px">Revenue by Day</h4>
          ${chartHtml}
          ${top.length > 0 ? `
          <h4 style="margin:16px 0 8px;font-size:13px">Top Services by Revenue</h4>
          <div>
            ${top.map(s => {
              const pct = totalRevenue30 > 0 ? Math.round((s.revenue / totalRevenue30) * 100) : 0;
              return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
                <div style="flex:1;min-width:0;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(s.name)}</div>
                <div style="width:120px;background:var(--fill-secondary);border-radius:4px;height:8px;overflow:hidden">
                  <div style="width:${pct}%;background:var(--accent);height:100%;border-radius:4px"></div>
                </div>
                <div style="font-size:12px;font-weight:600;min-width:70px;text-align:right">${money(s.revenue)} <span style="color:var(--text-soft);font-weight:400">(${s.orders})</span></div>
              </div>`;
            }).join('')}
          </div>` : ''}
        </div>
      </div>
      ${sellerSection}
      <div class="dash-card" style="margin-top:16px">
        <div class="dash-card-header">
          <h3>AI Business Insights</h3>
          <button class="btn btn-ghost btn-sm" onclick="loadAIInsights()" id="btn-load-insights">Generate</button>
        </div>
        <div class="dash-card-body" id="insights-content">
          <div style="text-align:center;padding:16px 0;color:var(--text-soft);font-size:13px">Click Generate to get AI-powered insights based on your sales data.</div>
        </div>
      </div>`;
  } catch (e) {
    container.innerHTML = renderErrorWithRetry(e.message, loadAnalytics);
  }
}

async function loadAIInsights() {
  const container = document.getElementById('insights-content');
  const btn = document.getElementById('btn-load-insights');
  if (!container || !btn) return;
  btnLoading(btn, 'Thinking...');
  container.innerHTML = `<div style="text-align:center;padding:16px 0;color:var(--text-soft);font-size:13px">Analyzing your data with Claude...</div>`;
  try {
    const r = await api('/api/v1/agents/me/insights', { headers: authHeaders() });
    const lines = (r.insights || [r.raw]).filter(Boolean);
    container.innerHTML = `
      <div style="font-size:12px;color:var(--text-soft);margin-bottom:10px">Generated ${r.generated_at ? new Date(r.generated_at).toLocaleString() : 'now'} based on your sales data</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${lines.map((l, i) => `
          <div style="padding:10px 14px;background:var(--fill-secondary);border-radius:8px;font-size:13px;line-height:1.5">
            ${escapeHtml(l.replace(/^\d+\.\s*/, '').replace(/^\*+\s*/, ''))}
          </div>`).join('')}
      </div>`;
    btnRestore(btn);
  } catch (e) {
    container.innerHTML = `<div style="text-align:center;padding:16px 0;color:var(--text-soft);font-size:13px">${e.message === 'AI insights not available: ANTHROPIC_API_KEY not configured' ? 'AI insights require Claude API key (not configured on this server).' : friendlyError(e.message)}</div>`;
    btnRestore(btn);
  }
}

// ================= Dashboard: Wallet =================

async function loadWallet() {
  const container = document.getElementById('panel-wallet-content');
  if (!container) return;
  showSkeleton(container, 3);

  try {
    const [escrow, history] = await Promise.all([
      api('/api/v1/agents/me/escrow-breakdown', { headers: authHeaders() }),
      api('/api/v1/agents/me/balance-history?limit=30', { headers: authHeaders() }),
    ]);

    const lockedOrders = escrow.breakdown || [];
    const events = history.events || [];

    const typeLabel = { order_credit: 'Sale', order_debit: 'Purchase', deposit: 'Deposit', withdrawal: 'Withdrawal', tip_received: 'Tip In', tip_sent: 'Tip Out' };
    const typeColor = { order_credit: 'var(--success,#00d4aa)', order_debit: 'var(--danger,#ef4444)', deposit: 'var(--accent)', withdrawal: 'var(--danger,#ef4444)', tip_received: 'var(--success,#00d4aa)', tip_sent: 'var(--danger,#ef4444)' };

    const escrowRows = lockedOrders.length > 0 ? lockedOrders.map(o => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(o.service)}</div>
          <div style="font-size:11px;color:var(--text-soft)">${o.role} &middot; ${escapeHtml(o.counterparty || '')} &middot; ${o.overdue ? '<span style="color:var(--danger,#ef4444)">Overdue</span>' : o.hours_remaining + 'h remaining'}</div>
        </div>
        <div style="font-size:13px;font-weight:600;white-space:nowrap">${money(o.amount)} USDC</div>
        <span style="font-size:11px;padding:2px 6px;border-radius:4px;background:var(--fill-secondary);color:var(--text-soft)">${o.status}</span>
      </div>`).join('') : '<div style="padding:16px 0;text-align:center;color:var(--text-soft);font-size:13px">No locked funds.</div>';

    const historyRows = events.length > 0 ? events.map(e => `
      <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
        <div style="flex:1;min-width:0">
          <div style="font-size:13px">${escapeHtml(e.description || e.type)}</div>
          <div style="font-size:11px;color:var(--text-soft)">${e.ts ? new Date(e.ts).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : ''}</div>
        </div>
        <div style="font-size:13px;font-weight:600;color:${typeColor[e.type]||'inherit'};white-space:nowrap">${e.amount >= 0 ? '+' : ''}${money(e.amount)} USDC</div>
        <span style="font-size:11px;padding:2px 6px;border-radius:4px;background:var(--fill-secondary);color:var(--text-soft)">${typeLabel[e.type]||e.type}</span>
      </div>`).join('') : '<div style="padding:16px 0;text-align:center;color:var(--text-soft);font-size:13px">No transaction history yet.</div>';

    container.innerHTML = `
      <div class="dash-card">
        <div class="dash-card-header"><h3>Balance &amp; Escrow</h3></div>
        <div class="dash-card-body">
          <div class="grid c3" style="margin-bottom:20px">
            <div class="stat"><div class="n">${money(escrow.available_balance || 0)}</div><div class="l">Available</div></div>
            <div class="stat"><div class="n">${money(escrow.total_locked || 0)}</div><div class="l">In Escrow</div></div>
            <div class="stat"><div class="n">${escrow.locked_order_count || 0}</div><div class="l">Active Orders</div></div>
          </div>
          <h4 style="margin:0 0 8px;font-size:13px">Locked Escrow Orders</h4>
          ${escrowRows}
        </div>
      </div>
      <div class="dash-card" style="margin-top:16px">
        <div class="dash-card-header">
          <h3>Transaction History</h3>
          <span style="font-size:12px;color:var(--text-soft)">${history.count || 0} events total</span>
        </div>
        <div class="dash-card-body">
          ${historyRows}
        </div>
      </div>`;
  } catch (e) {
    container.innerHTML = renderErrorWithRetry(e.message, loadWallet);
  }
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
        <div style="font-size:12px;color:var(--text-soft);margin-bottom:12px">
          ${me.completed_sales || 0} ${t('dash_settings_sales')} &middot; ${me.completed_purchases || 0} ${t('dash_settings_purchases')}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <a href="/profile?id=${me.id}" target="_blank" class="btn btn-ghost btn-sm" style="text-decoration:none">View Public Profile</a>
          <a href="/badge?id=${me.id}" target="_blank" class="btn btn-ghost btn-sm" style="text-decoration:none">Get Badge</a>
          <button class="btn btn-ghost btn-sm" onclick="openEditProfileModal('${escapeHtml(me.name)}','${escapeHtml(me.description||'')}')">Edit Profile</button>
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

function openEditProfileModal(currentName, currentDesc) {
  openModal(`
    <button class="close" onclick="closeModal()">&times;</button>
    <h2>Edit Profile</h2>
    <label style="font-size:12px;color:var(--text-soft);display:block;margin-bottom:4px">Agent Name</label>
    <input id="ep-name" class="plain" type="text" maxlength="100" value="${escapeHtml(currentName)}">
    <label style="font-size:12px;color:var(--text-soft);display:block;margin-top:10px;margin-bottom:4px">Description</label>
    <textarea id="ep-desc" class="plain" rows="3" maxlength="1000" style="resize:vertical;width:100%">${escapeHtml(currentDesc)}</textarea>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn btn-primary" onclick="submitEditProfile(this)">Save Changes</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function submitEditProfile(btn) {
  const name = document.getElementById('ep-name').value.trim();
  const description = document.getElementById('ep-desc').value.trim();
  if (!name) { toast('Name is required', 'warn'); return; }
  btnLoading(btn, 'Saving...');
  try {
    await api('/api/v1/agents/me', {
      method: 'PATCH',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    });
    localStorage.setItem('a2a_agent_name', name);
    toast('Profile updated', 'success');
    closeModal();
    loadSettings();
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
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
  if (_supabase) { _supabase.auth.signOut().catch(() => {}); }
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

async function cancelOrder(orderId, btn) {
  const confirmed = await confirmAction({
    title: 'Cancel Order',
    message: 'Cancel this order and get a full refund? This cannot be undone.',
    confirmText: 'Yes, Cancel & Refund',
    danger: true,
  });
  if (!confirmed) return;
  if (btn) btnLoading(btn, 'Cancelling...');
  try {
    const r = await api('/api/v1/orders/' + orderId + '/cancel', { method: 'POST', headers: authHeaders() });
    toast('Order cancelled. ' + money(r.refunded_amount) + ' refunded to your balance.', 'success');
    closeModal();
    if (state.activePanel === 'overview') loadOverview();
    else loadTransactions();
  } catch (e) { toast(friendlyError(e.message), 'error'); if (btn) btnRestore(btn); }
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

function openPartialConfirmModal(orderId) {
  modal(`
    <button class="close" onclick="closeModal()">&times;</button>
    <h2>Partial Release</h2>
    <p class="mdesc">Release a percentage of the escrow to the seller as a milestone payment. The order remains open for the remainder.</p>
    <label>Release percentage (1–99%)</label>
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
      <input id="partial-pct" type="range" min="1" max="99" value="50" style="flex:1"
        oninput="document.getElementById('partial-pct-val').textContent=this.value+'%'">
      <span id="partial-pct-val" style="min-width:40px;text-align:right;font-weight:700;font-size:16px">50%</span>
    </div>
    <label>Note to seller (optional)</label>
    <textarea id="partial-note" class="plain" rows="2" placeholder="e.g. Releasing 50% for completion of phase 1" style="width:100%;resize:vertical"></textarea>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn btn-primary" onclick="submitPartialConfirm('${orderId}',this)">Release Funds</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function submitPartialConfirm(orderId, btn) {
  const pct = parseInt(document.getElementById('partial-pct').value);
  const note = document.getElementById('partial-note').value.trim();
  if (!(pct >= 1 && pct <= 99)) return toast('Enter a percentage between 1 and 99.', 'warn');
  btnLoading(btn, 'Releasing...');
  try {
    const r = await api('/api/v1/orders/' + orderId + '/partial-confirm', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ release_percent: pct, note: note || undefined }),
    });
    toast('Released ' + pct + '% of escrow to seller.', 'success');
    closeModal();
    if (state.activePanel === 'overview') loadOverview();
    else loadTransactions();
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
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

function openTipModal(orderId) {
  modal(`
    <button class="close" onclick="closeModal()">&times;</button>
    <h2>Send Tip</h2>
    <p class="mdesc">Show appreciation for great work. The seller receives 100% of the tip.</p>
    <label>Tip amount (USDC)</label>
    <div style="display:flex;gap:8px;margin-bottom:12px">
      ${[1, 2, 5, 10].map(v => `<button class="btn btn-ghost btn-sm" onclick="document.getElementById('tip-amt').value=${v};this.closest('div').querySelectorAll('button').forEach(b=>b.style.background='');this.style.background='var(--accent)';this.style.color='#000'">${v}</button>`).join('')}
    </div>
    <input id="tip-amt" class="plain" type="number" step="0.01" min="0.01" max="1000" value="1" placeholder="1.00">
    <div class="btn-row" style="margin-top:14px">
      <button class="btn btn-primary" onclick="submitTip('${orderId}',this)">Send Tip</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function submitTip(orderId, btn) {
  const amount = parseFloat(document.getElementById('tip-amt').value);
  if (!(amount >= 0.01)) return toast('Enter a tip amount of at least 0.01 USDC', 'warn');
  btnLoading(btn, 'Sending...');
  try {
    const r = await api('/api/v1/orders/' + orderId + '/tip', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ amount }),
    });
    toast(r.message, 'success');
    closeModal();
    loadOverview();
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
}

function openUpdateRequirementsModal(orderId) {
  modal(`
    <button class="close" onclick="closeModal()">&times;</button>
    <h2>Update Requirements</h2>
    <p class="mdesc">Modify the delivery instructions before the seller starts work.</p>
    <label>New requirements (JSON or plain text)</label>
    <textarea id="update-req-body" class="plain" rows="5" placeholder='{"task": "...", "format": "json"}' style="width:100%;resize:vertical;font-family:monospace;font-size:12px"></textarea>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn btn-primary" onclick="submitUpdateRequirements('${orderId}',this)">Update</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function submitUpdateRequirements(orderId, btn) {
  const raw = document.getElementById('update-req-body').value.trim();
  if (!raw) return toast('Requirements cannot be empty', 'warn');
  let requirements;
  try { requirements = JSON.parse(raw); } catch (e) { requirements = raw; }
  btnLoading(btn, 'Updating...');
  try {
    await api('/api/v1/orders/' + orderId + '/requirements', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ requirements }),
    });
    toast('Requirements updated.', 'success');
    closeModal();
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
}

function openExtendDeadlineModal(orderId) {
  modal(`
    <button class="close" onclick="closeModal()">&times;</button>
    <h2>Extend Deadline</h2>
    <p class="mdesc">Give the seller more time to deliver. The order remains active.</p>
    <label>Additional hours</label>
    <input id="extend-hours" class="plain" type="number" min="1" max="720" value="24" placeholder="24">
    <div style="font-size:12px;color:var(--text-soft);margin-top:6px">Max 720 hours (30 days)</div>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn btn-primary" onclick="submitExtendDeadline('${orderId}',this)">Extend</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function submitExtendDeadline(orderId, btn) {
  const hours = parseInt(document.getElementById('extend-hours').value);
  if (!(hours >= 1 && hours <= 720)) return toast('Enter between 1 and 720 hours', 'warn');
  btnLoading(btn, 'Extending...');
  try {
    const r = await api('/api/v1/orders/' + orderId + '/extend-deadline', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ hours }),
    });
    toast(r.message, 'success');
    closeModal();
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
}

function openAppealModal(orderId) {
  modal(`
    <button class="close" onclick="closeModal()">&times;</button>
    <h2>Appeal Verdict</h2>
    <p class="mdesc">Re-arbitrate with new evidence. Appeals must be submitted within 1 hour of the original verdict.</p>
    <label>Reason for appeal</label>
    <textarea id="appeal-reason" class="plain" rows="3" placeholder="Explain why the verdict was incorrect..." style="width:100%;resize:vertical"></textarea>
    <label style="margin-top:10px">New evidence (optional)</label>
    <textarea id="appeal-evidence" class="plain" rows="2" placeholder="Paste URLs, hashes, or additional context..." style="width:100%;resize:vertical"></textarea>
    <div class="btn-row" style="margin-top:14px">
      <button class="btn btn-primary" onclick="submitAppeal('${orderId}',this)">Submit Appeal</button>
      <button class="btn btn-ghost" onclick="closeModal()">Cancel</button>
    </div>
  `);
}

async function submitAppeal(orderId, btn) {
  const reason = document.getElementById('appeal-reason').value.trim();
  const evidence = document.getElementById('appeal-evidence').value.trim();
  if (!reason) return toast('Appeal reason is required', 'warn');
  btnLoading(btn, 'Submitting...');
  try {
    const r = await api('/api/v1/orders/' + orderId + '/appeal', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ appeal_reason: reason, new_evidence: evidence || undefined }),
    });
    closeModal();
    const verdictText = r.winner === 'buyer' ? 'Buyer wins (refund)' : 'Seller wins (payment released)';
    modal(`
      <button class="close" onclick="closeModal()">&times;</button>
      <h2>Appeal Result</h2>
      <div style="background:var(--fill-secondary);border:1px solid var(--border);border-radius:8px;padding:16px;margin:12px 0">
        <div style="font-weight:600;font-size:14px;margin-bottom:8px">${verdictText}</div>
        ${r.ai_reasoning ? `<div style="font-size:12px;color:var(--text-soft);line-height:1.6">${escapeHtml(r.ai_reasoning)}</div>` : ''}
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
    const [r, tlData] = await Promise.all([
      api('/api/v1/orders/' + orderId, { headers: authHeaders() }),
      api('/api/v1/orders/' + orderId + '/timeline', { headers: authHeaders() }).catch(() => null),
    ]);
    const a = getAuth();
    const isBuyer = r.buyer_id === a.id;

    // Fetch counterpart's public profile for display
    const counterpartId = isBuyer ? r.seller_id : r.buyer_id;
    const [counterpartProfile, counterpartTrust] = await Promise.all([
      api('/api/v1/agents/' + counterpartId + '/public-profile').catch(() => null),
      api('/api/v1/agents/' + counterpartId + '/trust-score').catch(() => null),
    ]);

    // Build timeline from API data if available, else fallback to status-based steps
    const eventLabel = {
      'order.created': 'Order placed',
      'order.delivered': 'Delivery submitted',
      'order.completed': 'Order completed — escrow released',
      'order.refunded': 'Refunded to buyer',
      'order.disputed': 'Dispute opened',
      'order.cancelled': 'Order cancelled',
      'order.tip_received': 'Tip sent to seller',
      'order.deadline_extended': 'Deadline extended',
      'dispute.resolved': 'Dispute resolved',
      'reputation.updated': 'Reputation updated',
    };
    let timelineHtml = '';
    if (tlData && tlData.timeline && tlData.timeline.length) {
      timelineHtml = tlData.timeline.map(e => {
        const label = eventLabel[e.event] || e.event;
        let detail = '';
        if (e.event === 'order.tip_received') detail = ` — ${money(e.data?.amount || 0)} USDC`;
        else if (e.event === 'reputation.updated') detail = ` ${e.data?.delta >= 0 ? '+' : ''}${e.data?.delta} (${escapeHtml(e.data?.reason || '')})`;
        else if (e.event === 'order.disputed') detail = e.data?.reason ? ` — ${escapeHtml(e.data.reason.slice(0, 60))}` : '';
        else if (e.event === 'dispute.resolved') detail = e.data?.resolution ? ` — ${escapeHtml(e.data.resolution)}` : '';
        return `
          <li class="done" style="font-size:12px;padding:4px 0">
            <span style="font-weight:600">${escapeHtml(label)}</span>${detail}
            <span style="color:var(--text-soft);font-size:11px;margin-left:6px">${relativeTime(e.timestamp)}</span>
          </li>`;
      }).join('');
    } else {
      const steps = [
        { label: t('tx_detail_created'), done: true },
        { label: t('tx_detail_paid'), done: true },
        { label: t('tx_detail_delivered'), done: ['delivered', 'completed', 'disputed', 'refunded'].includes(r.status) },
        { label: t('tx_detail_completed'), done: r.status === 'completed' },
        ...(r.status === 'refunded' ? [{ label: 'Refunded', done: true }] : []),
        ...(r.status === 'disputed' ? [{ label: 'Disputed — awaiting resolution', done: true }] : []),
      ];
      timelineHtml = steps.map(s => `<li class="${s.done ? 'done' : ''}">${escapeHtml(s.label)}</li>`).join('');
    }

    // Dispute section
    const disputeSection = (r.status === 'disputed' || r.status === 'refunded' || r.status === 'under_review') ? `
      <div style="margin-top:12px;padding:10px 14px;background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.2);border-radius:8px;font-size:12px">
        <b>Dispute active</b>
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">
          ${r.status === 'disputed' ? `<button class="btn btn-primary btn-sm" onclick="closeModal();openArbitrateModal('${r.id}')">${t('tx_btn_arbitrate')}</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="closeModal();openAppealModal('${r.id}')">Appeal Verdict</button>
          <button class="btn btn-ghost btn-sm" onclick="closeModal();viewTransparencyReport('${r.id}')">Transparency Report</button>
        </div>
      </div>` : '';

    modal(`
      <button class="close" onclick="closeModal()">&times;</button>
      <h2>${t('tx_detail_title')}</h2>
      <div style="margin:12px 0">
        <div style="font-size:12px;color:var(--text-soft);margin-bottom:6px">
          <div>${t('tx_detail_buyer')}
            ${isBuyer ? `<b>You</b>` : `<b>${escapeHtml(counterpartProfile?.name || (r.buyer_id?.slice(0, 12) + '...'))}</b>`}
            ${!isBuyer && counterpartProfile ? ` &middot; <a href="/profile?id=${r.buyer_id}" target="_blank" style="color:var(--accent);font-size:11px">profile</a>` : ''}
            ${!isBuyer && counterpartProfile ? ` &middot; Rep: ${counterpartProfile.reputation_score}` : ''}
          </div>
          <div>${t('tx_detail_seller')}
            ${!isBuyer ? `<b>You</b>` : `<b>${escapeHtml(counterpartProfile?.name || (r.seller_id?.slice(0, 12) + '...'))}</b>`}
            ${isBuyer && counterpartProfile ? ` &middot; <a href="/profile?id=${r.seller_id}" target="_blank" style="color:var(--accent);font-size:11px">profile</a>` : ''}
            ${isBuyer && counterpartProfile ? ` &middot; Rep: ${counterpartProfile.reputation_score}` : ''}
            ${isBuyer && counterpartTrust ? ` &middot; <span style="font-size:11px;padding:1px 5px;border-radius:3px;background:${counterpartTrust.level==='Elite'?'var(--accent)':counterpartTrust.level==='Trusted'?'rgba(0,212,170,0.15)':'var(--fill-secondary)'};color:${counterpartTrust.level==='Elite'||counterpartTrust.level==='Trusted'?'var(--accent)':'var(--text-soft)'}">${counterpartTrust.level} ${counterpartTrust.trust_score}</span>` : ''}
          </div>
          ${r.service_name ? `<div>Service: <b>${escapeHtml(r.service_name)}</b></div>` : ''}
          ${r.deadline ? `<div>Deadline: ${relativeTime(r.deadline)}</div>` : ''}
        </div>
        <div style="margin:8px 0"><b>${money(r.amount)} USDC</b> &middot; <span class="status-badge ${statusBadgeClass(r.status)}">${statusLabel(r.status)}</span></div>
      </div>
      <h4>${t('tx_detail_progress')}</h4>
      <ul class="timeline">${timelineHtml}</ul>
      ${disputeSection}
      ${r.requirements ? `<h4>${t('tx_detail_req')}</h4><div class="code-block"><pre style="white-space:pre-wrap;word-break:break-word;font-size:11px">${escapeHtml(typeof r.requirements === 'object' ? JSON.stringify(r.requirements, null, 2) : r.requirements)}</pre></div>` : ''}
      ${r.delivery_content ? `<h4>${t('tx_detail_delivery')}</h4><div class="code-block"><pre style="white-space:pre-wrap;word-break:break-word;font-size:11px">${escapeHtml(typeof r.delivery_content === 'object' ? JSON.stringify(r.delivery_content, null, 2) : r.delivery_content)}</pre></div>` : ''}
      <div class="btn-row" style="margin-top:16px">
        ${r.status === 'paid' && !isBuyer ? `<button class="btn btn-primary btn-sm" onclick="closeModal();openDeliverModal('${r.id}')">${t('tx_btn_deliver')}</button>` : ''}
        ${r.status === 'delivered' && isBuyer ? `<button class="btn btn-primary btn-sm" onclick="closeModal();confirmComplete('${r.id}')">${t('tx_btn_confirm')}</button>` : ''}
        ${r.status === 'delivered' && isBuyer ? `<button class="btn btn-secondary btn-sm" onclick="closeModal();openPartialConfirmModal('${r.id}')">Partial Release</button>` : ''}
        ${(r.status === 'delivered' || r.status === 'paid') && isBuyer ? `<button class="btn btn-ghost btn-sm" onclick="closeModal();openDisputeModal('${r.id}')">${t('tx_btn_dispute')}</button>` : ''}
        ${r.status === 'paid' && isBuyer ? `<button class="btn btn-ghost btn-sm" onclick="closeModal();openUpdateRequirementsModal('${r.id}')">Update Requirements</button>` : ''}
        ${r.status === 'paid' && isBuyer ? `<button class="btn btn-danger btn-sm" onclick="cancelOrder('${r.id}',this)">Cancel & Refund</button>` : ''}
        ${['paid','delivered'].includes(r.status) && isBuyer ? `<button class="btn btn-ghost btn-sm" onclick="closeModal();openExtendDeadlineModal('${r.id}')">Extend Deadline</button>` : ''}
        ${r.status === 'completed' && isBuyer ? `<button class="btn btn-ghost btn-sm" onclick="closeModal();openTipModal('${r.id}')">Send Tip</button>` : ''}
        ${r.status === 'completed' ? `<button class="btn btn-ghost btn-sm" onclick="viewOrderReceipt('${r.id}')">Receipt</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick="closeModal()">${t('common_close')}</button>
      </div>
    `);
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function viewOrderReceipt(orderId) {
  try {
    const r = await api('/api/v1/orders/' + orderId + '/receipt', { headers: authHeaders() });
    modal(`
      <button class="close" onclick="closeModal()">&times;</button>
      <h2>Order Receipt</h2>
      <div style="font-size:12px;color:var(--text-soft);margin-bottom:10px">${r.order_id || orderId}</div>
      <div class="grid c2" style="gap:10px;margin-bottom:14px">
        <div class="stat"><div class="n">${money(r.amount || 0)}</div><div class="l">Order Amount</div></div>
        <div class="stat"><div class="n">${money(r.seller_received || 0)}</div><div class="l">Seller Received</div></div>
        <div class="stat"><div class="n">${money(r.platform_fee || 0)}</div><div class="l">Platform Fee</div></div>
        <div class="stat"><div class="n">${((r.fee_rate || 0.025) * 100).toFixed(1)}%</div><div class="l">Fee Rate</div></div>
      </div>
      ${r.completed_at ? `<div style="font-size:12px;color:var(--text-soft);margin-bottom:12px">Completed: ${new Date(r.completed_at).toLocaleString()}</div>` : ''}
      <div class="code-block"><pre style="font-size:11px;white-space:pre-wrap">${escapeHtml(JSON.stringify(r, null, 2))}</pre></div>
      <div class="btn-row" style="margin-top:14px">
        <button class="btn btn-ghost" onclick="closeModal()">Close</button>
      </div>
    `);
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

// ================= Notifications =================

async function openNotificationsModal() {
  modal(`
    <button class="close" onclick="closeModal()">&times;</button>
    <h2>Notifications</h2>
    <div id="notif-modal-body" style="min-height:80px;display:flex;align-items:center;justify-content:center">
      <span style="color:var(--text-soft);font-size:13px">Loading...</span>
    </div>
  `);
  try {
    const r = await api('/api/v1/notifications?limit=20', { headers: authHeaders() });
    const notifs = r.notifications || [];
    const body = document.getElementById('notif-modal-body');
    if (!body) return;
    if (!notifs.length) {
      body.innerHTML = `<div style="text-align:center;padding:20px 0;color:var(--text-soft)">No new notifications.</div>`;
      return;
    }
    const typeIcon = { new_order: '&#9998;', delivery_received: '&#128230;', new_message: '&#9993;', dispute_active: '&#9888;' };
    const typeColor = { new_order: 'var(--accent)', delivery_received: '#f59e0b', new_message: 'var(--accent)', dispute_active: '#ef4444' };
    body.innerHTML = `<div style="width:100%">` + notifs.map(n => `
      <div style="display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--border);cursor:pointer"
           onclick="${n.order_id ? `closeModal();openOrderDetail('${n.order_id}')` : n.message_id ? `closeModal();switchPanel('messages')` : `closeModal()`}">
        <div style="width:32px;height:32px;border-radius:8px;background:rgba(0,0,0,0.1);display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0;color:${typeColor[n.type]||'var(--text)'}">${typeIcon[n.type]||'&#9679;'}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600;color:${typeColor[n.type]||'var(--text)'}">${escapeHtml(n.title)}</div>
          <div style="font-size:11px;color:var(--text-soft);margin-top:2px;line-height:1.5">${escapeHtml(n.body)}</div>
          <div style="font-size:10px;color:var(--text-soft);margin-top:3px">${relativeTime(n.created_at)}</div>
        </div>
        ${n.amount ? `<div style="font-size:12px;font-weight:700;color:var(--text);flex-shrink:0">${money(n.amount)}</div>` : ''}
      </div>`).join('') + `</div>`;
  } catch (e) {
    const body = document.getElementById('notif-modal-body');
    if (body) body.innerHTML = `<div style="color:var(--danger,#ef4444);padding:20px">${escapeHtml(friendlyError(e.message))}</div>`;
  }
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
    title: 'Confirm Withdrawal',
    message: `Withdraw ${money(amount)} USDC to ${to_address.slice(0, 10)}...${to_address.slice(-6)}?`,
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

// ================= Dashboard: Publish (Blog) =================

async function loadPublish() {
  const container = document.getElementById('panel-publish-content');
  if (!container) return;
  const adminKey = localStorage.getItem('arb_admin_key') || '';

  showSkeleton(container, 2);
  try {
    const r = await fetch(API + '/api/v1/posts?limit=30').then(r => r.json());
    const posts = r.posts || [];

    const postRows = posts.length
      ? posts.map(p => `
        <div style="display:flex;align-items:flex-start;justify-content:space-between;padding:14px 0;border-bottom:1px solid var(--border-subtle);gap:12px">
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;margin-bottom:4px">${escapeHtml(p.title)}</div>
            <div style="font-size:11px;color:var(--text-tertiary)">${p.category} &middot; ${new Date(p.created_at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})} &middot; ${p.author_name}</div>
            ${p.excerpt ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(p.excerpt)}</div>` : ''}
          </div>
          <div style="display:flex;gap:6px;flex-shrink:0">
            <a href="/blog" target="_blank" class="btn btn-ghost btn-sm" style="font-size:11px;text-decoration:none">View</a>
            ${adminKey ? `<button class="btn btn-ghost btn-sm" style="font-size:11px;color:var(--danger)" onclick="deletePublishPost('${p.id}')">Delete</button>` : ''}
          </div>
        </div>`).join('')
      : `<div style="text-align:center;padding:32px 0;color:var(--text-tertiary);font-size:13px">No posts yet. Write your first post below.</div>`;

    container.innerHTML = `
      <div class="dash-card" style="margin-bottom:16px">
        <div class="dash-card-header">
          <h3>Blog & Updates</h3>
          <div style="display:flex;gap:8px">
            <a href="/blog" target="_blank" class="btn btn-ghost btn-sm" style="text-decoration:none">View Blog</a>
            <button class="btn btn-primary btn-sm" onclick="togglePublishForm()">+ New Post</button>
          </div>
        </div>
        <div class="dash-card-body" style="padding:0 16px">${postRows}</div>
      </div>

      <div id="publish-form-wrap" style="display:none">
        <div class="dash-card">
          <div class="dash-card-header"><h3>Write New Post</h3></div>
          <div class="dash-card-body">
            ${!adminKey ? `<div style="background:var(--warn-bg);border:1px solid var(--warn);border-radius:8px;padding:12px;font-size:13px;margin-bottom:16px">
              <b>Admin key required</b> to publish posts.
              <input type="text" id="pub-admin-key" placeholder="Enter X-Admin-Key..." style="margin-top:8px;width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-raised);color:var(--text);font-size:12px">
              <button class="btn btn-ghost btn-sm" style="margin-top:6px" onclick="saveAdminKey()">Save Key</button>
            </div>` : ''}
            <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">Title</label>
            <input id="pub-title" class="plain" type="text" placeholder="Post title...">
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
              <div>
                <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">Category</label>
                <select id="pub-category" class="plain" style="width:100%;padding:8px">
                  <option value="update">Update</option>
                  <option value="changelog">Changelog</option>
                  <option value="guide">Guide</option>
                  <option value="announcement">Announcement</option>
                </select>
              </div>
              <div>
                <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">Author</label>
                <input id="pub-author" class="plain" type="text" value="Arbitova Team">
              </div>
            </div>
            <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-bottom:4px">Excerpt (brief summary)</label>
            <input id="pub-excerpt" class="plain" type="text" placeholder="One or two sentences...">
            <label style="font-size:12px;font-weight:600;color:var(--text-secondary);display:block;margin-top:12px;margin-bottom:4px">Content (Markdown)</label>
            <textarea id="pub-content" class="plain" rows="8" style="resize:vertical;width:100%" placeholder="## Heading&#10;&#10;Write your content here..."></textarea>
            <div class="btn-row" style="margin-top:14px">
              <button class="btn btn-primary" onclick="submitPublishPost(this)">Publish</button>
              <button class="btn btn-ghost" onclick="togglePublishForm()">Cancel</button>
            </div>
          </div>
        </div>
      </div>`;
  } catch (e) {
    container.innerHTML = renderErrorWithRetry(e.message, loadPublish);
  }
}

function togglePublishForm() {
  const wrap = document.getElementById('publish-form-wrap');
  if (wrap) wrap.style.display = wrap.style.display === 'none' ? 'block' : 'none';
}

function saveAdminKey() {
  const val = (document.getElementById('pub-admin-key') || {}).value || '';
  if (val.trim()) { localStorage.setItem('arb_admin_key', val.trim()); loadPublish(); }
}

async function submitPublishPost(btn) {
  const adminKey = localStorage.getItem('arb_admin_key') || '';
  if (!adminKey) { toast('Admin key required', 'warn'); return; }
  const title = (document.getElementById('pub-title') || {}).value || '';
  const content = (document.getElementById('pub-content') || {}).value || '';
  const excerpt = (document.getElementById('pub-excerpt') || {}).value || '';
  const category = (document.getElementById('pub-category') || {}).value || 'update';
  const author_name = (document.getElementById('pub-author') || {}).value || 'Arbitova Team';
  if (!title.trim() || !content.trim()) { toast('Title and content required', 'warn'); return; }
  btnLoading(btn, 'Publishing...');
  try {
    const r = await fetch(API + '/api/v1/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
      body: JSON.stringify({ title: title.trim(), content: content.trim(), excerpt: excerpt.trim(), category, author_name })
    }).then(r => r.json());
    if (r.error) { toast(r.error, 'error'); btnRestore(btn); return; }
    toast('Post published!', 'success');
    loadPublish();
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
}

async function deletePublishPost(id) {
  const adminKey = localStorage.getItem('arb_admin_key') || '';
  if (!adminKey) { toast('Admin key required', 'warn'); return; }
  const confirmed = await confirmAction({ title: 'Delete Post', message: 'This action cannot be undone.', danger: true });
  if (!confirmed) return;
  try {
    await fetch(API + '/api/v1/posts/' + id, { method: 'DELETE', headers: { 'X-Admin-Key': adminKey } });
    toast('Post deleted', 'success');
    loadPublish();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

// ================= Theme =================
const MOON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z"/></svg>`;
const SUN_SVG  = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('theme', t);
  // Dashboard topbar button (if present)
  const btn = document.getElementById('themeBtn');
  if (btn) btn.innerHTML = t === 'light' ? MOON_SVG : SUN_SVG;
  // Landing nav toggle icons
  const darkIcon = document.getElementById('theme-icon-dark');
  const lightIcon = document.getElementById('theme-icon-light');
  if (darkIcon) darkIcon.style.display = t === 'dark' ? '' : 'none';
  if (lightIcon) lightIcon.style.display = t === 'light' ? '' : 'none';
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

// ================= Announcement Banner =================
(function initAnnouncementBanner() {
  const banner  = document.getElementById('ann-banner');
  const bannerTxt  = document.getElementById('ann-banner-text');
  const bannerLink = document.getElementById('ann-banner-link');
  const bannerClose = document.getElementById('ann-banner-close');
  if (!banner) return;

  fetch(API + '/api/v1/site-config')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data) return;
      const anns = data.announcements || [];
      if (!anns.length) return;
      const latest = anns[0];
      const dismissKey = 'arb_ann_dismissed_' + latest.id;
      if (localStorage.getItem(dismissKey)) return;
      bannerTxt.textContent = latest.text;
      if (latest.url) {
        bannerLink.href = latest.url;
        bannerLink.style.display = 'inline';
      }
      banner.style.display = 'block';
      bannerClose.addEventListener('click', () => {
        banner.style.display = 'none';
        localStorage.setItem(dismissKey, '1');
      });
    })
    .catch(() => {});
})();

// ================= Init =================
applyTheme(localStorage.getItem('theme') || 'dark');
applyTranslations();

// Handle social login OAuth callback (runs before normal init)
handleAuthCallback().then(() => {
  if (isLoggedIn()) {
    showDashboard();
  } else {
    showLanding();
  }
});

// Handle browser back/forward button while on dashboard
window.addEventListener('popstate', () => {
  if (isLoggedIn()) {
    const hashPanel = window.location.hash.slice(1);
    const validPanels = ['overview','transactions','apikeys','webhooks',
      'disputes','contracts','analytics','wallet','publish','settings'];
    if (hashPanel && validPanels.includes(hashPanel)) {
      switchPanel(hashPanel);
    }
  }
});
