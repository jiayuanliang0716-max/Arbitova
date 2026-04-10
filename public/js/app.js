function t(key) { return (LANG[currentLang] || LANG.en)[key] || key; }
function applyTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.dataset.i18nHtml); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.dataset.i18nPlaceholder); });
  document.documentElement.lang = currentLang === 'zh' ? 'zh-Hant' : 'en';
  const lb = document.getElementById('langBtn');
  if (lb) lb.textContent = currentLang === 'en' ? '中' : 'EN';
}
function toggleLang() {
  currentLang = currentLang === 'en' ? 'zh' : 'en';
  localStorage.setItem('lang', currentLang);
  applyTranslations();
  updateIdBar();
}

// ================= State & storage =================
const API = '';
const K = { id: 'a2a_agent_id', key: 'a2a_api_key', name: 'a2a_agent_name', onboarded: 'a2a_onboarded' };
const state = { bundleItems: [], lastServices: [], marketPage: 1, marketTotal: 0, marketAllServices: [], marketScrollY: 0, marketSearchState: {} };

function getAuth() { return { id: localStorage.getItem(K.id), key: localStorage.getItem(K.key), name: localStorage.getItem(K.name) }; }
const getIdentity = () => { const a = getAuth(); return (a.id && a.key) ? a : null; };
function setAuth(id, key, name) {
  localStorage.setItem(K.id, id);
  localStorage.setItem(K.key, key);
  if (name) localStorage.setItem(K.name, name);
  updateIdBar();
}
function authHeaders() { const k = localStorage.getItem(K.key); return k ? { 'X-API-Key': k } : {}; }

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
  // Strip raw HTTP codes for display
  if (/^HTTP \d{3}$/.test(msg)) return 'Something went wrong. Please try again.';
  return msg;
}

let _isOffline = false;
window.addEventListener('online', () => {
  _isOffline = false;
  toast(currentLang === 'en' ? 'Connection restored' : '連線已恢復', 'success');
});
window.addEventListener('offline', () => {
  _isOffline = true;
  toast(currentLang === 'en' ? 'You are offline. Some features may not work.' : '你目前離線。部分功能可能無法使用。', 'error', 6000);
});

async function api(path, opts = {}) {
  if (_isOffline) throw new Error('You are offline. Please check your connection.');
  opts.headers = opts.headers || {};
  if (opts.body && !opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
  let res;
  try {
    res = await fetch(API + path, opts);
  } catch (e) {
    throw new Error(friendlyError(e.message));
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

// Inject skeleton CSS once
(function injectSkeletonCSS() {
  if (document.getElementById('skeleton-styles')) return;
  const style = document.createElement('style');
  style.id = 'skeleton-styles';
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

    /* Mobile hamburger */
    .hamburger-btn {
      display: none;
      background: none;
      border: 1px solid var(--border, #333);
      border-radius: 8px;
      padding: 6px 8px;
      cursor: pointer;
      color: var(--text, #fff);
      z-index: 1001;
    }
    .hamburger-btn svg { display: block; }
    .nav-backdrop {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.5);
      z-index: 999;
    }
    .nav-backdrop.show { display: block; }

    @media (max-width: 768px) {
      .hamburger-btn { display: flex; align-items: center; justify-content: center; }
      .nav.mobile-nav {
        position: fixed;
        top: 0; left: 0;
        width: 260px;
        height: 100vh;
        background: var(--bg, #0d0d0f);
        border-right: 1px solid var(--border, #333);
        z-index: 1000;
        transform: translateX(-100%);
        transition: transform 0.25s ease;
        flex-direction: column;
        padding: 60px 12px 20px;
        overflow-y: auto;
      }
      .nav.mobile-nav.open { transform: translateX(0); }
      .nav.mobile-nav button {
        justify-content: flex-start;
        padding: 12px 16px;
        width: 100%;
        text-align: left;
        font-size: 14px;
      }
    }

    /* Confirmation modal styles */
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

    /* Button loading state */
    .btn.btn-loading {
      pointer-events: none;
      opacity: 0.7;
      position: relative;
    }

    /* Load more bar */
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

    /* Search loading indicator */
    .search-loading {
      display: none;
      width: 16px; height: 16px;
      border: 2px solid var(--border, #333);
      border-top-color: var(--primary, #007aff);
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      flex-shrink: 0;
    }
    .search-loading.active { display: inline-block; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* Retry button in error boxes */
    .err-box-with-retry {
      text-align: center;
      padding: 24px;
    }
    .err-box-with-retry .err-msg {
      color: var(--danger, #e55);
      margin-bottom: 12px;
      font-size: 13px;
    }

    /* Review stars visualization */
    .star-bar { display: flex; align-items: center; gap: 4px; margin-bottom: 4px; }
    .star-bar .bar-track { flex: 1; height: 6px; background: var(--border, #333); border-radius: 3px; overflow: hidden; max-width: 120px; }
    .star-bar .bar-fill { height: 100%; background: var(--warn, #f5a623); border-radius: 3px; }
    .star-bar .star-label { font-size: 11px; color: var(--text-soft); width: 14px; text-align: right; }
    .star-bar .star-count { font-size: 11px; color: var(--text-dim); width: 24px; }
  `;
  document.head.appendChild(style);
})();

// ================= Toast =================
function toast(msg, type = 'info', ms) {
  // Auto-dismiss: success = 2s, error = 5s, others = 3.5s
  if (ms === undefined) {
    if (type === 'success') ms = 2000;
    else if (type === 'error') ms = 5000;
    else ms = 3500;
  }
  const container = document.getElementById('toasts');
  // Ensure aria-live for screen readers
  if (!container.hasAttribute('aria-live')) {
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'false');
    container.setAttribute('role', 'status');
  }
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.setAttribute('role', 'alert');
  t.textContent = msg;
  container.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .3s, transform .3s'; t.style.opacity = '0'; t.style.transform = 'translateX(20px)'; setTimeout(() => t.remove(), 300); }, ms);
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
          <button class="btn btn-ghost confirm-cancel">${escapeHtml(cancelText || (currentLang === 'en' ? 'Cancel' : '取消'))}</button>
          <button class="${btnClass} confirm-ok">${escapeHtml(confirmText || (currentLang === 'en' ? 'Confirm' : '確認'))}</button>
        </div>
      </div>
    `;

    const cleanup = (result) => {
      overlay.remove();
      resolve(result);
    };

    overlay.querySelector('.confirm-cancel').addEventListener('click', () => cleanup(false));
    overlay.querySelector('.confirm-ok').addEventListener('click', () => { if (onConfirm) onConfirm(); cleanup(true); });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') cleanup(false); });

    document.body.appendChild(overlay);
    // Focus the confirm button for keyboard users
    overlay.querySelector('.confirm-ok').focus();
  });
}

// ================= Modal =================
function modal(html) {
  const modalEl = document.getElementById('modal');
  const bodyEl = document.getElementById('modalBody');
  bodyEl.innerHTML = html;
  modalEl.classList.add('show');
  modalEl.setAttribute('role', 'dialog');
  modalEl.setAttribute('aria-modal', 'true');

  // Auto-focus first input/textarea inside modal
  requestAnimationFrame(() => {
    const firstInput = bodyEl.querySelector('input:not([type="hidden"]), textarea, select');
    if (firstInput) firstInput.focus();
  });
}
function closeModal() {
  document.getElementById('modal').classList.remove('show');
}
document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });

// Escape key closes modals
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const modalEl = document.getElementById('modal');
    if (modalEl.classList.contains('show')) {
      closeModal();
      e.preventDefault();
    }
  }
});

// Tab trapping inside modal
document.getElementById('modal').addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const modalBody = document.getElementById('modalBody');
  const focusable = modalBody.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey) {
    if (document.activeElement === first) { last.focus(); e.preventDefault(); }
  } else {
    if (document.activeElement === last) { first.focus(); e.preventDefault(); }
  }
});

function closeOnboard() { document.getElementById('onboard').classList.remove('show'); localStorage.setItem(K.onboarded, '1'); }

// ================= Sub-tabs =================
function switchSubTab(btn, tabId) {
  const container = btn.closest('.sec');
  container.querySelectorAll('.subtab-btn').forEach(b => b.classList.remove('active'));
  container.querySelectorAll('.subtab-content').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById(tabId).classList.add('active');
  if (tabId === 'mkt-h2a')      loadH2AMarket();
  if (tabId === 'mkt-a2a')      loadA2AMarket();
  if (tabId === 'mkt-lb')       loadLeaderboard();
  if (tabId === 'ord-list')     loadMyOrders();
  if (tabId === 'ord-bundle')   loadBundleSelect();
  if (tabId === 'ord-subs')     loadSubscriptions();
  if (tabId === 'acct-overview') loadAccount();
  if (tabId === 'acct-services') loadMyServices();
  if (tabId === 'acct-creds')    loadCreds();
}

// ================= Navigation =================
const panelParents = { discover:'market', leaderboard:'market', publish:'account', register:'account', bundle:'orders', subscriptions:'orders', tos:'help', privacy:'help' };
function showPanel(name) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
  const p = document.getElementById('p-' + name);
  if (p) p.classList.add('active');
  const navTarget = panelParents[name] || name;
  const btn = document.querySelector('.nav button[data-panel="' + navTarget + '"]');
  if (btn) btn.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Close mobile nav if open
  closeMobileNav();

  if (name === 'home')    loadStats();
  if (name === 'account') { loadAccount(); }
  if (name === 'market')  { restoreMarketState(); loadH2AMarket(); }
  if (name === 'orders')  loadMyOrders();
  if (name === 'settings') loadSettingsForm();
  if (name === 'inbox')   loadInbox();
}
document.querySelectorAll('.nav button').forEach(b => b.addEventListener('click', () => showPanel(b.dataset.panel)));

// ================= Mobile Navigation =================
(function initMobileNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  nav.classList.add('mobile-nav');

  // Create hamburger button
  const hamburger = document.createElement('button');
  hamburger.className = 'hamburger-btn';
  hamburger.setAttribute('aria-label', 'Open navigation menu');
  hamburger.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>';

  // Create backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'nav-backdrop';
  backdrop.id = 'navBackdrop';
  document.body.appendChild(backdrop);

  // Insert hamburger before nav
  const header = document.querySelector('.site-header');
  if (header) {
    // Insert at start of header flex
    header.insertBefore(hamburger, header.firstChild);
  }

  hamburger.addEventListener('click', () => {
    nav.classList.toggle('open');
    backdrop.classList.toggle('show');
    hamburger.setAttribute('aria-expanded', nav.classList.contains('open'));
  });

  backdrop.addEventListener('click', closeMobileNav);

  // Close on nav item click
  nav.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', closeMobileNav);
  });
})();

function closeMobileNav() {
  const nav = document.getElementById('nav');
  const backdrop = document.getElementById('navBackdrop');
  const hamburger = document.querySelector('.hamburger-btn');
  if (nav) nav.classList.remove('open');
  if (backdrop) backdrop.classList.remove('show');
  if (hamburger) hamburger.setAttribute('aria-expanded', 'false');
}

// ================= Accessibility: aria-labels =================
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

// ================= Identity bar =================
function updateIdBar() {
  const bar = document.getElementById('idBar');
  const info = document.getElementById('idInfo');
  const cta = document.getElementById('header-cta');
  const a = getAuth();
  if (a.id && a.key) {
    bar.classList.add('ok');
    info.innerHTML = t('logged_in_as') + '<b>' + escapeHtml(a.name || 'Agent') + '</b> <span class="small">(' + a.id.slice(0, 8) + '…)</span>';
    if (cta) cta.innerHTML = '<button class="btn btn-ghost btn-sm" onclick="showPanel(\'account\')">' + t('btn_my_account') + '</button>';
  } else {
    bar.classList.remove('ok');
    info.innerHTML = t('not_logged_in') + ' <a class="hint-link" onclick="showPanel(\'register\')">' + t('free_join') + '</a> ' + (currentLang === 'en' ? 'or' : '或') + ' <a class="hint-link" onclick="showPanel(\'settings\')">' + t('enter_key') + '</a>';
    if (cta) cta.innerHTML = '<button class="btn btn-primary btn-sm" onclick="showPanel(\'register\')">' + t('btn_join') + '</button>';
  }
}

// ================= Helpers =================
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function money(n) { return parseFloat(n || 0).toFixed(2); }
function copyToClipboard(text) { navigator.clipboard.writeText(text).then(() => toast(t('toast_copied'), 'success')); }
function statusLabel(s) { return ({ paid: t('status_paid'), delivered: t('status_delivered'), completed: t('status_completed'), disputed: t('status_disputed'), refunded: t('status_refunded') })[s] || s; }

// Debounce helper
function debounce(fn, delay) {
  let timer;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// Button loading state helpers
function btnLoading(btn, text) {
  if (!btn) return;
  btn._origText = btn.textContent;
  btn._origDisabled = btn.disabled;
  btn.disabled = true;
  btn.textContent = text || 'Processing...';
  btn.classList.add('btn-loading');
}
function btnRestore(btn) {
  if (!btn) return;
  btn.disabled = btn._origDisabled || false;
  btn.textContent = btn._origText || '';
  btn.classList.remove('btn-loading');
}

// Error box with retry
function renderErrorWithRetry(message, retryFn) {
  return `<div class="err-box-with-retry">
    <div class="err-msg">${escapeHtml(friendlyError(message))}</div>
    <button class="btn btn-ghost btn-sm" onclick="(${retryFn.toString()})()">
      ${currentLang === 'en' ? 'Retry' : '重試'}
    </button>
  </div>`;
}

// ================= Stats =================
async function loadStats() {
  try {
    const s = await api('/api/stats');
    document.getElementById('s-agents').textContent = s.agents;
    document.getElementById('s-services').textContent = s.services;
    document.getElementById('s-orders').textContent = s.completed_orders;
    document.getElementById('s-fees').textContent = money(s.platform_fees);
  } catch (e) { console.error(e); }
}

// ================= Account =================
async function loadAccount() {
  const a = getAuth();
  const view = document.getElementById('account-view');
  if (!a.id || !a.key) {
    view.innerHTML = '<div class="warn-box">' + t('ord_please_login') + '</div>';
    return;
  }
  showSkeleton(view, 2);
  try {
    const [me, walletInfo] = await Promise.all([
      api('/agents/' + a.id, { headers: authHeaders() }),
      api('/agents/' + a.id + '/wallet', { headers: authHeaders() }).catch(() => null)
    ]);
    const isChain = walletInfo?.mode === 'chain';
    const walletSection = walletInfo?.wallet_address ? `
      <div style="margin:16px 0;padding:16px;background:var(--bg-soft);border:1px solid var(--border);border-radius:10px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
          <b style="font-size:13px;">${t('acct_deposit_address')}</b>
          <span style="font-size:10.5px;background:${isChain ? 'var(--success-bg)' : 'var(--warn-bg)'};color:${isChain ? 'var(--success)' : 'var(--warn)'};padding:2px 8px;border-radius:4px;font-weight:600;">${isChain ? t('chain_mock').replace('Mock','Base') + (walletInfo.chain || '') : t('chain_mock')}</span>
        </div>
        <div style="font-family:monospace;font-size:12px;word-break:break-all;color:var(--text-soft);margin-bottom:10px;">${walletInfo.wallet_address}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <button class="btn btn-ghost btn-sm" onclick="copyText('${walletInfo.wallet_address}')">${t('acct_copy_addr')}</button>
          ${isChain ? `<button class="btn btn-primary btn-sm" onclick="syncBalance()">${t('acct_sync')}</button>` : ''}
          ${isChain ? `<button class="btn btn-ghost btn-sm" onclick="openWithdrawModal()">${t('acct_withdraw')}</button>` : `<button class="btn btn-secondary btn-sm" onclick="openTopupModal()">${t('acct_mock_topup')}</button>`}
        </div>
        ${isChain && walletInfo.chain_balance !== null ? `<div class="small" style="margin-top:8px;">${t('acct_chain_bal')}${money(walletInfo.chain_balance)}</div>` : ''}
        ${isChain ? `<div class="small" style="margin-top:4px;">${t('acct_chain_hint')}</div>` : ''}
      </div>` : '';

    view.innerHTML = `
      <div class="grid c4">
        <div class="stat"><div class="n">${money(me.balance)}</div><div class="l">${t('acct_bal')}</div></div>
        <div class="stat"><div class="n">${money(me.escrow)}</div><div class="l">${t('acct_escrow')}</div></div>
        <div class="stat"><div class="n">${money(me.stake)}</div><div class="l">${t('acct_stake')}</div></div>
        <div class="stat"><div class="n">${me.reputation_score}</div><div class="l">${t('acct_rep')}</div></div>
      </div>
      ${walletSection}
      <h3>${t('acct_actions')}</h3>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="openStakeModal()">${t('acct_manage_stake')}</button>
        <button class="btn btn-ghost" onclick="openRepHistory('${me.id}')">${t('acct_rep_history')}</button>
        <button class="btn btn-ghost" onclick="openDepositHistory()">${t('acct_deposit_history')}</button>
      </div>
      <h3>${t('acct_profile')}</h3>
      <div class="muted" style="line-height:1.85">
        <b style="color:var(--text)">${escapeHtml(me.name)}</b><br>
        ${escapeHtml(me.description || t('acct_no_desc'))}<br>
        <span class="small">Agent ID: <code style="color:var(--warn);font-family:monospace">${me.id}</code></span><br>
        <span class="small">${me.completed_sales || 0} ${t('acct_sales')} · ${me.completed_purchases || 0} ${t('acct_purchases')}</span>
      </div>
    `;
    if (me.name) localStorage.setItem(K.name, me.name);
    updateIdBar();
  } catch (e) {
    view.innerHTML = renderErrorWithRetry(e.message, loadAccount);
  }
}

// ================= My Services =================
async function loadMyServices() {
  const el = document.getElementById('my-services-list');
  if (!el) return;
  const a = getAuth();
  if (!a.id || !a.key) { el.innerHTML = `<div class="warn-box">${t('ord_please_login')}</div>`; return; }
  showSkeleton(el, 2);
  try {
    const r = await api(`/agents/${a.id}/services`, { headers: authHeaders() });
    if (!r.services.length) {
      el.innerHTML = `<div class="empty"><div class="empty-icon">· · ·</div><h3>${t('my_svc_empty')}</h3><p>${t('my_svc_empty_sub')}</p><button class="btn btn-primary" onclick="showPanel('publish')">${t('acct_publish_btn')}</button></div>`;
      return;
    }
    el.innerHTML = r.services.map(s => {
      const active = s.is_active === true || s.is_active === 1;
      const mkt = s.market_type === 'a2a' ? '<span class="badge b-manual">A2A</span>' : '<span class="badge b-auto">H2A</span>';
      const dp = s.file_id ? `<span class="badge b-rep">${t('h2a_digital')}</span>` : '';
      return `
      <div class="order" style="opacity:${active ? 1 : 0.55}">
        <div class="top">
          <div>
            <div class="name">${escapeHtml(s.name)}</div>
            <div class="role">${money(s.price)} USDC · ${s.delivery_hours}h ${mkt} ${dp}</div>
          </div>
          <span class="st ${active ? 'st-paid' : 'st-refunded'}">${active ? t('svc_active') : t('svc_inactive')}</span>
        </div>
        <div class="small" style="margin-top:4px;color:var(--text-soft)">${escapeHtml(s.description || '—')}</div>
        ${s.file_name ? `<div class="small" style="margin-top:2px">File: ${escapeHtml(s.file_name)}</div>` : ''}
        <div class="actions" style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-ghost btn-sm" onclick="toggleService('${s.id}', ${!active})">${active ? t('svc_deactivate') : t('svc_activate')}</button>
          <button class="btn btn-ghost btn-sm" onclick="copyText('${s.id}')">${t('svc_copy_id')}</button>
        </div>
      </div>`;
    }).join('');
  } catch (e) { el.innerHTML = renderErrorWithRetry(e.message, loadMyServices); }
}

async function toggleService(id, activate) {
  try {
    await api(`/services/${id}`, { method: 'PATCH', headers: authHeaders(), body: JSON.stringify({ is_active: activate }) });
    toast(activate ? t('toast_svc_activated') : t('toast_svc_deactivated'), 'success');
    loadMyServices();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

// ================= Credentials =================
function loadCreds() {
  const el = document.getElementById('creds-view');
  if (!el) return;
  const a = getAuth();
  if (!a.id || !a.key) { el.innerHTML = `<div class="warn-box">${t('ord_please_login')}</div>`; return; }
  el.innerHTML = `
    <div style="margin-bottom:20px">
      <h3 style="margin-bottom:4px" data-i18n="creds_title">Your Credentials</h3>
      <p class="muted" data-i18n="creds_sub">Use these to connect your AI agent or bot to the platform.</p>
    </div>

    <label data-i18n="creds_id_label">Account ID</label>
    <div class="keybox" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:14px">
      <code style="flex:1;word-break:break-all;font-size:12px">${escapeHtml(a.id)}</code>
      <button class="btn btn-ghost btn-sm" onclick="copyText('${a.id}')">${t('reg_copy')}</button>
    </div>

    <label data-i18n="creds_key_label">API Key <span class="hint" data-i18n="creds_key_hint">Keep this private</span></label>
    <div class="keybox" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:20px">
      <code style="flex:1;word-break:break-all;font-size:12px" id="api-key-display">${'•'.repeat(36)}</code>
      <button class="btn btn-ghost btn-sm" onclick="toggleKeyVisibility()">${t('creds_show')}</button>
      <button class="btn btn-ghost btn-sm" onclick="copyText('${a.key}')">${t('reg_copy')}</button>
    </div>

    <div style="background:var(--fill-secondary);border:1px solid var(--border);border-radius:8px;padding:16px">
      <div style="font-weight:600;font-size:13px;margin-bottom:10px" data-i18n="creds_connect_title">Connect Your AI Agent</div>
      <p class="muted" style="font-size:12px;margin-bottom:10px" data-i18n="creds_connect_sub">Paste these into your seller-agent script:</p>
      <pre style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px;font-size:11px;overflow-x:auto;margin:0">const SELLER = {
  id:  '${escapeHtml(a.id)}',
  key: '${escapeHtml(a.key)}'
};</pre>
      <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="copyText(\`const SELLER = {\\n  id:  '${a.id}',\\n  key: '${a.key}'\\n};\`)">${t('reg_copy')}</button>
    </div>

    <div style="margin-top:16px;background:var(--fill-secondary);border:1px solid var(--border);border-radius:8px;padding:16px">
      <div style="font-weight:600;font-size:13px;margin-bottom:6px" data-i18n="creds_api_title">API Endpoint</div>
      <code style="font-size:12px;color:var(--text-soft)">${location.origin}</code>
      <br><a class="hint-link" style="font-size:12px" href="/docs" target="_blank" data-i18n="creds_api_docs">View full API documentation →</a>
    </div>
  `;
}

function toggleKeyVisibility() {
  const el = document.getElementById('api-key-display');
  const a = getAuth();
  if (!el || !a.key) return;
  el.textContent = el.textContent.includes('•') ? a.key : '•'.repeat(36);
}

function openStakeModal() {
  modal(`
    <button class="close" onclick="closeModal()">×</button>
    <h2>${t('stake_title')}</h2>
    <p class="mdesc">${t('stake_desc')}</p>
    <label>${t('stake_label')}</label>
    <input id="stake-amt" type="number" step="0.01" min="0.01" class="plain" placeholder="10">
    <div class="btn-row">
      <button class="btn btn-primary" onclick="doStake('stake')">${t('stake_btn')}</button>
      <button class="btn btn-secondary" onclick="doStake('unstake')">${t('unstake_btn')}</button>
      <button class="btn btn-ghost" onclick="closeModal()">✕</button>
    </div>
  `);
}
async function doStake(action) {
  const amount = parseFloat(document.getElementById('stake-amt').value);
  if (!(amount > 0)) return toast(t('toast_fill_positive'), 'warn');
  const btn = document.querySelector('#modalBody .btn-primary');
  btnLoading(btn, 'Processing...');
  try {
    const r = await api('/agents/' + action, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ amount }) });
    toast(r.message, 'success');
    closeModal();
    loadAccount();
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
}

function openTopupModal() {
  modal(`
    <button class="close" onclick="closeModal()">×</button>
    <h2>${t('topup_title')}</h2>
    <p class="mdesc">${t('topup_desc')}</p>
    <label>${t('topup_label')}</label>
    <input id="topup-amt" type="number" step="0.01" min="0.01" value="50" class="plain">
    <div class="btn-row">
      <button class="btn btn-primary" onclick="doTopup()">${t('topup_confirm')}</button>
      <button class="btn btn-ghost" onclick="closeModal()">✕</button>
    </div>
  `);
}
async function doTopup() {
  const amount = parseFloat(document.getElementById('topup-amt').value);
  if (!(amount > 0)) return toast(t('toast_fill_positive'), 'warn');
  const btn = document.querySelector('#modalBody .btn-primary');
  btnLoading(btn, 'Processing...');
  try {
    const r = await api('/agents/topup', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ amount }) });
    toast(r.message, 'success');
    closeModal();
    loadAccount();
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
    loadAccount();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast(t('toast_copied'), 'success')).catch(() => toast(t('toast_copy_fail'), 'error'));
}

function openWithdrawModal() {
  modal(`
    <button class="close" onclick="closeModal()">×</button>
    <h2>${t('withdraw_title')}</h2>
    <p class="mdesc">${t('withdraw_desc')}</p>
    <label>${t('wd_addr_label')}</label>
    <input id="wd-addr" class="plain" placeholder="0x...">
    <label>${t('wd_amt_label')}</label>
    <input id="wd-amt" type="number" step="0.01" min="1" class="plain" placeholder="10">
    <div class="btn-row">
      <button class="btn btn-primary" onclick="confirmWithdraw()">${t('wd_confirm')}</button>
      <button class="btn btn-ghost" onclick="closeModal()">✕</button>
    </div>
  `);
}

// Withdraw with confirmation
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
    confirmText: currentLang === 'en' ? 'Confirm Withdrawal' : '確認提款',
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
  btnLoading(btn, 'Processing...');
  try {
    toast('...', 'info');
    const r = await api('/withdrawals', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ to_address, amount })
    });
    closeModal();
    modal(`
      <button class="close" onclick="closeModal()">×</button>
      <h2>${t('wd_success_title')}</h2>
      <div class="keybox">
        <b>${t('wd_addr_label')}</b> ${money(r.amount)} USDC<br>
        <b>${t('wd_amt_label')}</b> ${escapeHtml(r.to_address)}<br>
        ${r.tx_hash ? `<b>Tx Hash:</b><span style="font-size:11px;word-break:break-all">${r.tx_hash}</span>` : ''}
      </div>
      <button class="btn btn-primary" style="margin-top:14px;" onclick="closeModal();loadAccount();">OK</button>
    `);
    loadAccount();
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
}

async function openDepositHistory() {
  try {
    const r = await api('/withdrawals/deposits', { headers: authHeaders() });
    const items = r.deposits?.length
      ? r.deposits.map(d => `
          <li class="done">
            <b>+${money(d.amount)} USDC</b>
            <div class="t">${d.from_address ? t('dep_from') + d.from_address.slice(0,10) + '...' : ''} · ${d.confirmed_at || ''}</div>
            ${d.tx_hash ? `<div class="t" style="font-size:10px">${d.tx_hash}</div>` : ''}
          </li>`).join('')
      : `<p class="muted">${t('deposit_no_history')}</p>`;
    modal(`
      <button class="close" onclick="closeModal()">×</button>
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
          <b>${h.delta > 0 ? '+' : ''}${h.delta}</b> — ${escapeHtml(h.reason)}
          <div class="t">${h.order_id || ''}</div>
        </li>`).join('');
    modal(`
      <button class="close" onclick="closeModal()">×</button>
      <h2>${t('rep_title')}</h2>
      <p class="mdesc">${t('rep_current')} <b style="color:var(--primary)">${r.reputation_score}</b></p>
      <ul class="timeline">${items}</ul>
    `);
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

// ================= Register =================
document.getElementById('f-register').addEventListener('submit', async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  const btn = e.target.querySelector('button[type="submit"], .btn-primary');
  if (btn) btnLoading(btn, 'Registering...');
  try {
    const r = await api('/agents/register', { method: 'POST', body: JSON.stringify({
      name: f.get('name'),
      description: f.get('description') || undefined,
      owner_email: f.get('owner_email') || undefined
    })});
    setAuth(r.id, r.api_key, r.name);
    modal(`
      <button class="close" onclick="closeModal()">×</button>
      <h2>${t('reg_success_title')}</h2>
      <div class="success-box" style="margin-bottom:16px">${t('reg_got_usdc')}</div>
      <div style="background:var(--warn-bg);border:1px solid var(--warn);border-radius:8px;padding:12px;margin-bottom:16px;font-size:13px">
        <b>${t('reg_save_warn_title')}</b><br>${t('reg_save_warn_body')}
      </div>
      <label>${t('reg_agent_id')}</label>
      <div class="keybox" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${escapeHtml(r.id)} <button class="btn btn-ghost btn-sm" onclick="copyText('${r.id}')">${t('reg_copy')}</button></div>
      <label>${t('reg_api_key')}</label>
      <div class="keybox" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">${escapeHtml(r.api_key)} <button class="btn btn-ghost btn-sm" onclick="copyText('${r.api_key}')">${t('reg_copy')}</button></div>
      <p class="muted" style="font-size:12px;margin-top:8px">${t('reg_key_hint')}</p>
      <div style="margin-top:16px;font-weight:600;font-size:13px;margin-bottom:8px">${t('reg_what_next')}</div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="closeModal(); showPanel('market')">${t('reg_go_market')}</button>
        <button class="btn btn-secondary" onclick="closeModal(); showPanel('publish')">${t('reg_go_publish')}</button>
        <button class="btn btn-ghost" onclick="closeModal(); showPanel('account')">${t('reg_go_account')}</button>
      </div>
    `);
    e.target.reset();
  } catch (err) { toast(friendlyError(err.message), 'error'); }
  if (btn) btnRestore(btn);
});

// ================= Market =================
const MARKET_PAGE_SIZE = 12;

// Save and restore market search state
function saveMarketState() {
  const h2aQ = document.getElementById('h2a-q');
  const h2aMax = document.getElementById('h2a-max');
  const h2aSort = document.getElementById('h2a-sort');
  const h2aType = document.getElementById('h2a-type');
  state.marketSearchState = {
    q: h2aQ ? h2aQ.value : '',
    max: h2aMax ? h2aMax.value : '',
    sort: h2aSort ? h2aSort.value : '',
    type: h2aType ? h2aType.value : '',
  };
  state.marketScrollY = window.scrollY;
}
function restoreMarketState() {
  const s = state.marketSearchState;
  if (!s || !s.q && !s.max && !s.sort && !s.type) return;
  const h2aQ = document.getElementById('h2a-q');
  const h2aMax = document.getElementById('h2a-max');
  const h2aSort = document.getElementById('h2a-sort');
  const h2aType = document.getElementById('h2a-type');
  if (h2aQ && s.q) h2aQ.value = s.q;
  if (h2aMax && s.max) h2aMax.value = s.max;
  if (h2aSort && s.sort) h2aSort.value = s.sort;
  if (h2aType && s.type) h2aType.value = s.type;
}

// ── H2A Market (consumer-facing) ──────────────────────────────────────────
async function loadH2AMarket(append) {
  const q = document.getElementById('h2a-q').value.trim();
  const max = document.getElementById('h2a-max').value.trim();
  const sort = document.getElementById('h2a-sort').value;
  const params = new URLSearchParams({ market: 'h2a', sort });
  if (q) params.set('q', q);
  if (max) params.set('max_price', max);
  const ptype = document.getElementById('h2a-type').value;
  if (ptype) params.set('product_type', ptype);
  const list = document.getElementById('h2a-list');

  // Save search state for persistence
  saveMarketState();

  // Show skeleton only on fresh load
  if (!append) {
    showSkeleton(list, 6);
    state.marketPage = 1;
  }

  // Show search loading indicator
  const searchLoading = document.getElementById('h2a-search-loading');
  if (searchLoading) searchLoading.classList.add('active');

  try {
    const r = await api('/services/search?' + params);
    state.lastServices = r.services;
    state.marketAllServices = r.services;
    state.marketTotal = r.services.length;

    if (searchLoading) searchLoading.classList.remove('active');

    if (!r.services.length) {
      list.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="empty-icon">· · ·</div><h3>${t('mkt_empty_h')}</h3><p>${t('mkt_empty_p')}</p><button class="btn btn-primary" onclick="showPanel('publish')">${t('mkt_first_service')}</button></div>`;
      // Remove load more bar if present
      const existingBar = list.parentElement.querySelector('.load-more-bar');
      if (existingBar) existingBar.remove();
      return;
    }

    // Pagination: show first page
    const pageServices = r.services.slice(0, state.marketPage * MARKET_PAGE_SIZE);
    list.innerHTML = pageServices.map(s => renderH2ACard(s)).join('');
    renderLoadMoreBar(list, r.services.length);
  } catch (e) {
    if (searchLoading) searchLoading.classList.remove('active');
    list.innerHTML = renderErrorWithRetry(e.message, () => loadH2AMarket());
  }
}

function loadMoreH2AMarket() {
  state.marketPage++;
  const list = document.getElementById('h2a-list');
  const pageServices = state.marketAllServices.slice(0, state.marketPage * MARKET_PAGE_SIZE);
  list.innerHTML = pageServices.map(s => renderH2ACard(s)).join('');
  renderLoadMoreBar(list, state.marketAllServices.length);
}

function renderLoadMoreBar(list, totalCount) {
  const shown = Math.min(state.marketPage * MARKET_PAGE_SIZE, totalCount);
  const hasMore = shown < totalCount;

  // Remove existing bar
  const existingBar = list.parentElement.querySelector('.load-more-bar');
  if (existingBar) existingBar.remove();

  const bar = document.createElement('div');
  bar.className = 'load-more-bar';
  bar.innerHTML = `
    <span class="count">${shown} ${currentLang === 'en' ? 'of' : '/'} ${totalCount} ${currentLang === 'en' ? 'services' : '個服務'}</span>
    ${hasMore ? `<button class="btn btn-ghost btn-sm" onclick="loadMoreH2AMarket()">${currentLang === 'en' ? 'Load More' : '載入更多'}</button>` : ''}
  `;
  list.parentElement.appendChild(bar);
}

// Debounced search for H2A market
const _debouncedH2ASearch = debounce(() => { loadH2AMarket(); }, 300);

// Initialize search-as-you-type once DOM is ready
(function initSearchListeners() {
  // Defer so DOM elements exist
  requestAnimationFrame(() => {
    const h2aQ = document.getElementById('h2a-q');
    if (h2aQ) {
      // Add search loading indicator after the input
      if (!document.getElementById('h2a-search-loading')) {
        const indicator = document.createElement('span');
        indicator.className = 'search-loading';
        indicator.id = 'h2a-search-loading';
        h2aQ.parentElement.style.position = 'relative';
        h2aQ.parentElement.appendChild(indicator);
      }
      h2aQ.addEventListener('input', _debouncedH2ASearch);
    }
    const a2aQ = document.getElementById('a2a-q');
    if (a2aQ) {
      if (!document.getElementById('a2a-search-loading')) {
        const indicator = document.createElement('span');
        indicator.className = 'search-loading';
        indicator.id = 'a2a-search-loading';
        a2aQ.parentElement.style.position = 'relative';
        a2aQ.parentElement.appendChild(indicator);
      }
      a2aQ.addEventListener('input', debounce(() => { loadA2AMarket(); }, 300));
    }
  });
})();

function renderH2ACard(s) {
  const pt = s.product_type || 'ai_generated';
  const hasSub = s.sub_interval && parseFloat(s.sub_price || 0) > 0;
  const intervalLabel = { daily: t('int_daily'), weekly: t('int_weekly'), monthly: t('int_monthly') }[s.sub_interval] || '';

  // Product type badge
  const ptLabels = { digital: t('h2a_digital'), ai_generated: t('h2a_ai_gen'), subscription: t('h2a_subscribable'), external: t('pt_external') };
  const ptBadge = `<span class="badge b-auto">${ptLabels[pt] || pt}</span>`;
  const badges = [ptBadge];

  // Determine buttons based on product_type
  let buyButtons = '';
  if (pt === 'subscription') {
    buyButtons = `<button class="btn btn-primary btn-sm" onclick="subscribeToService('${s.id}')">${t('h2a_subscribe')} ${money(s.sub_price)}/${intervalLabel}</button>`;
  } else {
    const buyLabel = pt === 'digital' ? t('h2a_buy_dl') : t('h2a_buy_now');
    buyButtons = `
      <button class="btn btn-primary btn-sm" onclick='openBuyModal(${JSON.stringify(s).replace(/'/g, "&apos;")})'>${buyLabel}</button>
      <button class="btn btn-ghost btn-sm" onclick="buyWithFiat('${s.id}')">${t('svc_buy_fiat')}</button>
    `;
  }

  return `
    <div class="service" style="cursor:pointer" onclick="openH2AServiceDetail('${s.id}')">
      <div class="head">
        <div>
          <h4>${escapeHtml(s.name)}</h4>
          <div class="seller" style="font-size:11px;color:var(--text-soft)">${t('h2a_by')} ${escapeHtml(s.agent_name)}</div>
        </div>
        <div class="price" style="text-align:right">
          <div>${money(s.price)} USDC</div>
          ${hasSub && pt !== 'subscription' ? `<div style="font-size:11px;color:var(--text-soft)">${t('h2a_sub_from')} ${money(s.sub_price)}/${intervalLabel}</div>` : ''}
        </div>
      </div>
      <div class="desc">${escapeHtml(s.description || t('svc_no_desc'))}</div>
      <div class="badges" style="margin-bottom:8px">${badges.join('')}</div>
      <div class="btn-row" style="margin-top:0" onclick="event.stopPropagation()">
        ${buyButtons}
      </div>
    </div>`;
}

// ── A2A Market (developer / agent-facing) ─────────────────────────────────
async function loadA2AMarket() {
  const q = document.getElementById('a2a-q').value.trim();
  const max = document.getElementById('a2a-max').value.trim();
  const sort = document.getElementById('a2a-sort').value;
  const params = new URLSearchParams({ market: 'a2a', sort });
  if (q) params.set('q', q);
  if (max) params.set('max_price', max);
  const list = document.getElementById('a2a-list');

  showSkeleton(list, 4);
  const searchLoading = document.getElementById('a2a-search-loading');
  if (searchLoading) searchLoading.classList.add('active');

  try {
    const r = await api('/services/search?' + params);
    if (searchLoading) searchLoading.classList.remove('active');
    if (!r.services.length) {
      list.innerHTML = `<div class="empty" style="grid-column:1/-1"><div class="empty-icon">· · ·</div><h3>${t('mkt_empty_h')}</h3><p>${t('mkt_empty_p')}</p></div>`;
      return;
    }
    list.innerHTML = r.services.map(s => renderA2ACard(s)).join('');
  } catch (e) {
    if (searchLoading) searchLoading.classList.remove('active');
    list.innerHTML = renderErrorWithRetry(e.message, () => loadA2AMarket());
  }
}

function renderA2ACard(s) {
  const badges = [];
  badges.push(`<span class="badge b-rep">${t('badge_rep')} ${s.seller_reputation ?? 0}</span>`);
  if (s.auto_verify) badges.push(`<span class="badge b-auto">${t('badge_auto')}</span>`);
  if (s.input_schema || s.output_schema) badges.push(`<span class="badge b-manual">${t('badge_contract')}</span>`);
  if (parseFloat(s.min_seller_stake || 0) > 0) badges.push(`<span class="badge b-stake">${t('badge_stake')} ${s.min_seller_stake}</span>`);
  const hasSub = s.sub_interval && parseFloat(s.sub_price || 0) > 0;
  const intervalLabel = { daily: t('int_daily'), weekly: t('int_weekly'), monthly: t('int_monthly') }[s.sub_interval] || '';
  if (hasSub) badges.push(`<span class="badge b-auto">${intervalLabel} ${money(s.sub_price)}</span>`);
  return `
    <div class="service">
      <div class="head">
        <div><h4>${escapeHtml(s.name)}</h4><div class="seller">${t('svc_seller')} ${escapeHtml(s.agent_name)}</div></div>
        <div class="price">${money(s.price)} USDC</div>
      </div>
      <div class="desc">${escapeHtml(s.description || t('svc_no_desc'))}</div>
      <div class="badges">${badges.join('')}</div>
      <div class="meta"><span class="b">${s.delivery_hours}${t('svc_delivery_h')}</span></div>
      <div class="btn-row" style="margin-top:0">
        <button class="btn btn-primary btn-sm" onclick='openBuyModal(${JSON.stringify(s).replace(/'/g, "&apos;")})'>${t('svc_buy')}</button>
        ${hasSub ? `<button class="btn btn-ghost btn-sm" onclick="subscribeToService('${s.id}')">${t('svc_subscribe')} ${intervalLabel}</button>` : ''}
        <button class="btn btn-ghost btn-sm" onclick='openServiceDetail(${JSON.stringify(s).replace(/'/g, "&apos;")})'>${t('svc_detail')}</button>
      </div>
    </div>`;
}

// keep backward compat alias
function loadMarket() { loadH2AMarket(); }

// A2A service detail (developer/agent market — shows schema contracts)
function openServiceDetail(s) {
  const inSchema = s.input_schema ? (typeof s.input_schema === 'string' ? s.input_schema : JSON.stringify(s.input_schema, null, 2)) : t('svc_not_defined');
  const outSchema = s.output_schema ? (typeof s.output_schema === 'string' ? s.output_schema : JSON.stringify(s.output_schema, null, 2)) : t('svc_not_defined');
  modal(`
    <button class="close" onclick="closeModal()">×</button>
    <h2>${escapeHtml(s.name)}</h2>
    <p class="mdesc">${escapeHtml(s.description || '')}</p>
    <div class="grid c2">
      <div><span class="muted">${t('svc_detail_price')}</span><br><b style="color:var(--success)">${money(s.price)} USDC</b></div>
      <div><span class="muted">${t('svc_detail_delivery')}</span><br><b>${s.delivery_hours} ${t('svc_detail_hours')}</b></div>
      <div><span class="muted">${t('svc_detail_rep')}</span><br><b style="color:var(--primary)">${s.seller_reputation ?? 0}</b></div>
      <div><span class="muted">${t('svc_detail_auto')}</span><br><b>${s.auto_verify ? t('svc_yes') : t('svc_no')}</b></div>
    </div>
    <h3>${t('svc_input_contract')}</h3>
    <div class="keybox" style="white-space:pre-wrap;">${escapeHtml(inSchema)}</div>
    <h3>${t('svc_output_contract')}</h3>
    <div class="keybox" style="white-space:pre-wrap;">${escapeHtml(outSchema)}</div>
    <div class="btn-row">
      <button class="btn btn-primary" onclick='closeModal(); openBuyModal(${JSON.stringify(s).replace(/'/g, "&apos;")})'>${t('svc_buy_btn')}</button>
    </div>
  `);
}

// H2A service detail modal — shows full service info + reviews + dual buy buttons
function stars(rating) {
  const r = Math.round(rating || 0);
  return '★'.repeat(r) + '☆'.repeat(5 - r);
}

function starsVisualization(rating) {
  const pct = ((rating || 0) / 5 * 100).toFixed(0);
  return `<span style="color:var(--warn);letter-spacing:1px;font-size:15px;position:relative;display:inline-block;">
    <span style="color:var(--border);">☆☆☆☆☆</span>
    <span style="position:absolute;left:0;top:0;overflow:hidden;width:${pct}%;white-space:nowrap;">★★★★★</span>
  </span>`;
}

async function openH2AServiceDetail(serviceId) {
  // Find service from last loaded list
  const s = (state.lastServices || []).find(x => x.id === serviceId);
  if (!s) { toast('Service not found', 'error'); return; }

  const pt = s.product_type || 'ai_generated';
  const hasSub = s.sub_interval && parseFloat(s.sub_price || 0) > 0;
  const intervalLabelMap = { daily: t('int_daily'), weekly: t('int_weekly'), monthly: t('int_monthly') };
  const intervalLabel = intervalLabelMap[s.sub_interval] || '';

  const ptLabels = { digital: t('h2a_digital'), ai_generated: t('h2a_ai_gen'), subscription: t('h2a_subscribable'), external: t('pt_external') };
  const badges = [`<span class="badge b-auto">${ptLabels[pt] || pt}</span>`];
  if (s.auto_verify) badges.push(`<span class="badge b-auto">${t('badge_auto')}</span>`);

  // Product-type-specific info block
  const ptInfo = {
    digital: `<div class="info" style="margin-bottom:16px"><div class="title">${t('h2a_digital')}</div>Instant download after purchase. ${s.file_id ? 'File attached.' : ''}</div>`,
    ai_generated: `<div class="info" style="margin-bottom:16px"><div class="title">${t('h2a_ai_gen')}</div>Delivered within ${s.delivery_hours || 24} hours after purchase.</div>`,
    subscription: `<div class="info" style="margin-bottom:16px"><div class="title">${t('h2a_subscribable')}</div>Billed ${money(s.sub_price)} USDC / ${intervalLabelMap[s.sub_interval] || s.sub_interval}. Auto-charged from balance.</div>`,
    external: `<div class="info" style="margin-bottom:16px"><div class="title">${t('pt_external') || 'External Service'}</div>After purchase, seller provides access link or credentials.</div>`
  };

  // Buy buttons based on product_type
  let modalBuyButtons = '';
  if (pt === 'subscription') {
    modalBuyButtons = `<button class="btn btn-primary" onclick="closeModal(); subscribeToService('${s.id}')">${t('h2a_subscribe')} ${money(s.sub_price)}/${intervalLabel}</button>`;
  } else {
    const buyLabel = pt === 'digital' ? t('h2a_buy_dl') : t('h2a_buy_now');
    modalBuyButtons = `
      <button class="btn btn-primary" onclick='closeModal(); openBuyModal(${JSON.stringify(s).replace(/'/g, "&apos;")})'>${buyLabel}</button>
      <button class="btn btn-ghost" onclick="closeModal(); buyWithFiat('${s.id}')">${t('svc_buy_fiat')}</button>
    `;
  }

  modal(`
    <button class="close" onclick="closeModal()">×</button>
    <h2>${escapeHtml(s.name)}</h2>
    <div class="detail-seller">
      <span>${t('h2a_by')} <b>${escapeHtml(s.agent_name)}</b></span>
      <span style="color:var(--text-dim)">·</span>
      <span>${t('svc_detail_rep')}: <b style="color:var(--primary)">${s.seller_reputation ?? 0}</b></span>
    </div>
    <div class="detail-badges">${badges.join('')}</div>
    <div class="detail-price">${money(s.price)} USDC${hasSub && pt !== 'subscription' ? ` <span style="font-size:14px;font-weight:400;color:var(--text-soft)">· ${t('h2a_sub_from')} ${money(s.sub_price)}/${intervalLabel}</span>` : ''}</div>
    <div style="font-size:13px;color:var(--text-soft);margin-bottom:16px">${t('svc_detail_delivery')}: <b>${s.delivery_hours} ${t('svc_detail_hours')}</b></div>
    <div class="detail-desc">${escapeHtml(s.description || t('svc_no_desc'))}</div>
    ${ptInfo[pt] || ''}
    <div class="detail-buy-row" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;">
      ${modalBuyButtons}
      <button class="btn btn-ghost" onclick="addToBundle('${s.id}', '${escapeHtml(s.name).replace(/'/g, "\\'")}', ${s.price}, '${escapeHtml(s.agent_name).replace(/'/g, "\\'")}')">${currentLang === 'en' ? 'Add to Bundle' : '加入組合'}</button>
    </div>
    <div style="margin-bottom:16px;">
      <a class="hint-link" style="font-size:12px;cursor:pointer" onclick="closeModal(); searchSellerServices('${s.agent_id}', '${escapeHtml(s.agent_name).replace(/'/g, "\\'")}')">${currentLang === 'en' ? 'View more by' : '查看更多來自'} ${escapeHtml(s.agent_name)} →</a>
    </div>
    <h3>${t('svc_reviews')}</h3>
    <div id="h2a-reviews-area"><div class="empty"><span>${t('loading')}</span></div></div>
  `);

  // Fetch reviews async
  try {
    const r = await api('/reviews/service/' + serviceId);
    const area = document.getElementById('h2a-reviews-area');
    if (!area) return;
    if (!r.reviews || !r.reviews.length) {
      area.innerHTML = `<div class="empty" style="padding:20px 0;text-align:center;color:var(--text-dim)">${t('svc_no_reviews')}</div>`;
      return;
    }

    // Star rating distribution
    const dist = [0, 0, 0, 0, 0]; // index 0 = 1 star, etc.
    r.reviews.forEach(rv => { const s = Math.min(5, Math.max(1, Math.round(rv.rating || 0))); dist[s - 1]++; });
    const maxDist = Math.max(...dist, 1);

    const distHtml = `<div style="display:flex;gap:16px;align-items:center;margin-bottom:16px;">
      <div style="text-align:center;">
        <div style="font-size:28px;font-weight:700;color:var(--text)">${parseFloat(r.average_rating).toFixed(1)}</div>
        <div style="margin:4px 0">${starsVisualization(r.average_rating)}</div>
        <div style="font-size:11px;color:var(--text-soft)">${r.total_reviews} ${currentLang === 'en' ? 'reviews' : '則評價'}</div>
      </div>
      <div style="flex:1;">
        ${[5, 4, 3, 2, 1].map(star => `
          <div class="star-bar">
            <span class="star-label">${star}</span>
            <span style="color:var(--warn);font-size:11px">★</span>
            <div class="bar-track"><div class="bar-fill" style="width:${(dist[star - 1] / maxDist * 100).toFixed(0)}%"></div></div>
            <span class="star-count">${dist[star - 1]}</span>
          </div>`).join('')}
      </div>
    </div>`;

    const reviewsHtml = r.reviews.map(rv => `
      <div class="review-item" style="border-top:1px solid var(--border);padding-top:12px;margin-top:12px;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
          <span style="color:var(--warn);font-size:13px">${stars(rv.rating)}</span>
          <span style="font-size:12px;color:var(--text-soft)">${escapeHtml(rv.reviewer_name || 'Anonymous')} · ${rv.created_at ? new Date(rv.created_at).toLocaleDateString() : ''}</span>
        </div>
        ${rv.comment ? `<div style="font-size:13px;line-height:1.5;color:var(--text)">${escapeHtml(rv.comment)}</div>` : ''}
      </div>`).join('');
    area.innerHTML = distHtml + reviewsHtml;
  } catch(e) {
    const area = document.getElementById('h2a-reviews-area');
    if (area) area.innerHTML = `<div class="empty" style="padding:20px 0;text-align:center;color:var(--text-dim)">${t('svc_no_reviews')}</div>`;
  }
}

// Add to bundle from service detail modal
function addToBundle(serviceId, name, price, seller) {
  state.bundleItems.push({ service_id: serviceId, name, price: parseFloat(price), seller });
  renderBundle();
  toast(currentLang === 'en' ? 'Added to bundle' : '已加入組合', 'success');
}

// Search for seller's other services
function searchSellerServices(agentId, agentName) {
  showPanel('market');
  // Use the search box to filter by seller name
  const h2aQ = document.getElementById('h2a-q');
  if (h2aQ) {
    h2aQ.value = agentName;
    loadH2AMarket();
  }
}

// LemonSqueezy fiat checkout
async function buyWithFiat(serviceId) {
  const a = getAuth();
  if (!a.key) return toast(t('toast_please_register'), 'warn');
  try {
    const r = await api('/payments/checkout', {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ service_id: serviceId })
    });
    if (r.checkout_url) {
      window.open(r.checkout_url, '_blank');
    } else {
      toast('Payment system not configured', 'error');
    }
  } catch(e) { toast(friendlyError(e.message), 'error'); }
}

function openBuyModal(s) {
  if (!localStorage.getItem(K.key)) { toast(t('toast_please_register'), 'warn'); showPanel('register'); return; }
  const needsJson = !!s.input_schema;
  modal(`
    <button class="close" onclick="closeModal()">×</button>
    <h2>${escapeHtml(s.name)}</h2>
    <p class="mdesc">${money(s.price)} USDC — ${needsJson ? t('buy_json_warn') : ''}</p>
    <label>${needsJson ? t('buy_req_label_json') : t('buy_req_label')} ${needsJson ? '' : t('buy_req_opt')}</label>
    <textarea id="buy-req" ${needsJson ? '' : 'class="plain"'} placeholder="${needsJson ? '{"article": "..."}' : ''}"></textarea>
    <div class="btn-row">
      <button class="btn btn-primary" id="buy-confirm-btn" onclick="doBuy('${s.id}')">${t('buy_confirm')}</button>
      <button class="btn btn-ghost" onclick="closeModal()">✕</button>
    </div>
  `);
}
async function doBuy(serviceId) {
  const requirements = document.getElementById('buy-req').value;
  const btn = document.getElementById('buy-confirm-btn');
  btnLoading(btn, 'Processing...');
  try {
    const r = await api('/orders', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ service_id: serviceId, requirements: requirements || undefined }) });
    toast(t('toast_order_placed'), 'success');
    closeModal();
    showPanel('orders');
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
}

// ================= Discover =================
async function runDiscover() {
  const rawIn = document.getElementById('d-in').value.trim();
  const rawOut = document.getElementById('d-out').value.trim();
  const max = document.getElementById('d-max').value.trim();
  const body = {};
  if (rawIn)  { try { body.input_like  = JSON.parse(rawIn);  } catch { return toast(t('toast_invalid_json_in'), 'error'); } }
  if (rawOut) { try { body.output_like = JSON.parse(rawOut); } catch { return toast(t('toast_invalid_json_out'), 'error'); } }
  if (max) body.max_price = parseFloat(max);
  try {
    const r = await api('/services/discover', { method: 'POST', body: JSON.stringify(body) });
    const out = document.getElementById('discover-result');
    if (!r.matches.length) { out.innerHTML = `<div class="muted">${currentLang==='en'?'No matching services found. Try broadening your criteria.':'沒有找到匹配的服務。試試放寬條件。'}</div>`; return; }
    out.innerHTML = `<h3>${t('disc_results')}${r.matches.length})</h3>` + '<div class="grid c2">' +
      r.matches.map(m => renderServiceCard(m) + `<div class="small" style="margin-top:-6px;padding:0 4px;">${t('disc_score')} ${m.match_score} · ${m.match_reasons.join(' · ')}</div>`).join('') +
      '</div>';
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

// ================= Publish =================
function toggleAdvanced() { const a = document.getElementById('adv'); a.style.display = a.style.display === 'none' ? 'block' : 'none'; }

let selectedProductType = null;

function selectProductType(type) {
  selectedProductType = type;
  document.getElementById('pub-product-type').value = type;

  // Highlight selected card
  document.querySelectorAll('.product-type-card').forEach(c => c.classList.remove('selected'));
  document.querySelector(`.product-type-card[data-type="${type}"]`)?.classList.add('selected');

  // Show step 2
  document.getElementById('pub-step1').style.display = 'none';
  document.getElementById('pub-step2').style.display = 'block';

  // Update badge
  const labels = { digital: 'Digital Product', ai_generated: 'AI Service', subscription: 'Subscription', external: 'External Service' };
  document.getElementById('pub-type-badge').textContent = labels[type] || type;

  // Show/hide sections based on type
  document.getElementById('pub-digital-section').style.display = type === 'digital' ? 'block' : 'none';
  document.getElementById('pub-sub-section').style.display = type === 'subscription' ? 'block' : 'none';
  document.getElementById('pub-external-section').style.display = type === 'external' ? 'block' : 'none';
  document.getElementById('pub-delivery-hours-wrap').style.display = (type === 'digital') ? 'none' : 'block';
}

function backToStep1() {
  document.getElementById('pub-step1').style.display = 'block';
  document.getElementById('pub-step2').style.display = 'none';
}
async function handleFileSelect(input) {
  const file = input.files[0];
  if (!file) return;
  const statusEl = document.getElementById('file-status');
  const fileIdEl = document.getElementById('f-file-id');
  if (file.size > 5 * 1024 * 1024) { toast('File too large (max 5MB)', 'error'); input.value = ''; return; }
  statusEl.textContent = t('pub_uploading');

  // Show upload progress indicator
  const progressWrap = document.createElement('div');
  progressWrap.id = 'upload-progress';
  progressWrap.style.cssText = 'margin-top:8px;height:4px;background:var(--border);border-radius:2px;overflow:hidden;';
  progressWrap.innerHTML = '<div style="height:100%;background:var(--primary);width:0%;transition:width 0.3s;border-radius:2px" id="upload-bar"></div>';
  statusEl.parentElement.appendChild(progressWrap);

  try {
    const reader = new FileReader();
    reader.onprogress = (ev) => {
      if (ev.lengthComputable) {
        const bar = document.getElementById('upload-bar');
        if (bar) bar.style.width = Math.round(ev.loaded / ev.total * 70) + '%';
      }
    };
    reader.onload = async (ev) => {
      const bar = document.getElementById('upload-bar');
      if (bar) bar.style.width = '80%';
      const base64 = ev.target.result.split(',')[1];
      const r = await api('/files', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ filename: file.name, mimetype: file.type || 'application/octet-stream', content: base64 })
      });
      if (bar) bar.style.width = '100%';
      fileIdEl.value = r.id;
      statusEl.textContent = t('pub_file_ready') + ' ' + file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB)';
      statusEl.style.color = 'var(--green)';
      // Remove progress bar after short delay
      setTimeout(() => { const p = document.getElementById('upload-progress'); if (p) p.remove(); }, 800);
    };
    reader.readAsDataURL(file);
  } catch (e) {
    toast(friendlyError(e.message), 'error');
    statusEl.textContent = t('pub_no_file');
    statusEl.style.color = '';
    const p = document.getElementById('upload-progress');
    if (p) p.remove();
  }
}

document.getElementById('f-publish').addEventListener('submit', async e => {
  e.preventDefault();
  if (!localStorage.getItem(K.key)) { toast(t('toast_please_register'), 'warn'); return; }
  const f = new FormData(e.target);
  const body = {
    name: f.get('name'),
    description: f.get('description') || undefined,
    price: parseFloat(f.get('price')),
    delivery_hours: parseInt(f.get('delivery_hours')) || 24,
    auto_verify: !!f.get('auto_verify'),
    min_seller_stake: parseFloat(f.get('min_seller_stake') || 0)
  };
  for (const k of ['input_schema', 'output_schema', 'verification_rules']) {
    const raw = f.get(k);
    if (raw && raw.trim()) {
      try { body[k] = JSON.parse(raw); }
      catch { return toast(k + ' is not valid JSON', 'error'); }
    }
  }
  const fileId = f.get('file_id');
  if (fileId) body.file_id = fileId;
  body.market_type = f.get('market_type') || 'h2a';
  body.product_type = document.getElementById('pub-product-type').value || 'ai_generated';
  const btn = e.target.querySelector('button[type="submit"], .btn-primary');
  if (btn) btnLoading(btn, 'Publishing...');
  try {
    const r = await api('/services', { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
    toast(t('toast_service_published'), 'success');
    modal(`
      <button class="close" onclick="closeModal()">×</button>
      <h2>${t('pub_success_title')}</h2>
      <p class="mdesc">${t('pub_success_desc')}</p>
      <div class="success-box">${t('pub_success_id')} <code style="font-family:monospace">${r.id}</code></div>
      <div class="btn-row">
        <button class="btn btn-primary" onclick="closeModal(); showPanel('market'); loadMarket()">${t('pub_view')}</button>
      </div>
    `);
    e.target.reset();
    document.querySelector('#f-publish [name="delivery_hours"]').value = 24;
    document.getElementById('f-file-id').value = '';
    document.getElementById('file-status').textContent = t('pub_no_file');
    // Reset step-based publish UI
    backToStep1();
    selectedProductType = null;
    document.querySelectorAll('.product-type-card').forEach(c => c.classList.remove('selected'));
  } catch (err) { toast(friendlyError(err.message), 'error'); }
  if (btn) btnRestore(btn);
});

// ================= Orders =================
async function loadMyOrders() {
  const a = getAuth();
  const list = document.getElementById('orders-list');
  if (!a.id || !a.key) { list.innerHTML = `<div class="warn-box">${t('ord_please_login')}</div>`; return; }
  showSkeleton(list, 3);
  try {
    const r = await api('/agents/' + a.id + '/orders', { headers: authHeaders() });
    if (!r.orders.length) { list.innerHTML = `<div class="empty"><div class="empty-icon">· · ·</div><h3>${t('ord_no_orders_h')}</h3><p>${t('ord_no_orders_p')}</p><div style="display:flex;gap:8px;justify-content:center"><button class="btn btn-primary btn-sm" onclick="showPanel('market')">${t('ord_browse')}</button><button class="btn btn-ghost btn-sm" onclick="showPanel('publish')">${t('ord_publish')}</button></div></div>`; return; }
    list.innerHTML = r.orders.map(o => renderOrder(o, a.id)).join('');
  } catch (e) {
    list.innerHTML = renderErrorWithRetry(e.message, loadMyOrders);
  }
}
function renderOrder(o, myId) {
  const isBuyer = o.buyer_id === myId;
  const role = isBuyer ? t('role_buyer') : t('role_seller');
  const actions = [];
  if (!isBuyer && o.status === 'paid')      actions.push(`<button class="btn btn-primary btn-sm" onclick="openDeliverModal('${o.id}')">${t('btn_deliver')}</button>`);
  if (isBuyer && (o.status === 'paid' || o.status === 'delivered')) {
    actions.push(`<button class="btn btn-primary btn-sm" onclick="confirmOrder('${o.id}')">${t('btn_confirm')}</button>`);
    actions.push(`<button class="btn btn-danger btn-sm" onclick="confirmDispute('${o.id}')">${t('btn_dispute')}</button>`);
  }
  if (!isBuyer && o.status === 'delivered') actions.push(`<button class="btn btn-danger btn-sm" onclick="confirmDispute('${o.id}')">${t('btn_dispute')}</button>`);
  if (o.status === 'disputed') actions.push(`<button class="btn btn-primary btn-sm" onclick="openArbitrateModal('${o.id}')">${t('btn_arbitrate')}</button>`);
  if (!isBuyer && ['paid','delivered'].includes(o.status)) actions.push(`<button class="btn btn-ghost btn-sm" onclick="openSubdelegateModal('${o.id}')">${t('btn_subdelegate')}</button>`);
  actions.push(`<button class="btn btn-ghost btn-sm" onclick="viewOrderDetail('${o.id}')">${t('btn_detail')}</button>`);

  return `
    <div class="order">
      <div class="top">
        <div>
          <div class="name">${escapeHtml(o.service_name)}</div>
          <div class="role">${t('you_are')} ${role}</div>
        </div>
        <div>
          <span class="st st-${o.status}">${statusLabel(o.status)}</span>
          <span class="amt" style="margin-left:6px;">${money(o.amount)} USDC</span>
        </div>
      </div>
      ${o.requirements ? `<div class="req">${t('ord_requirements')} ${escapeHtml(o.requirements)}</div>` : ''}
      <div class="row" style="margin-top:10px; font-size:11px; color:var(--text-dim);">
        <span class="id">${o.id}</span>
        <span class="spacer"></span>
        <span>${t('ord_created')} ${o.created_at || ''}</span>
      </div>
      <div class="btn-row">${actions.join('')}</div>
    </div>`;
}

function openDeliverModal(orderId) {
  modal(`
    <button class="close" onclick="closeModal()">×</button>
    <h2>${t('deliver_title')}</h2>
    <p class="mdesc">${t('deliver_desc')}</p>
    <label>${t('deliver_label')}</label>
    <textarea id="del-content" placeholder="${t('deliver_placeholder')}"></textarea>
    <div class="btn-row">
      <button class="btn btn-primary" id="deliver-btn" onclick="doDeliver('${orderId}')">${t('deliver_submit')}</button>
      <button class="btn btn-ghost" onclick="closeModal()">✕</button>
    </div>
  `);
}
async function doDeliver(orderId) {
  const content = document.getElementById('del-content').value;
  if (!content) return toast(t('toast_fill_content'), 'warn');
  const btn = document.getElementById('deliver-btn');
  btnLoading(btn, 'Delivering...');
  try {
    const r = await api('/orders/' + orderId + '/deliver', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ content }) });
    if (r.status === 'completed') toast(t('toast_auto_pass'), 'success', 5000);
    else toast(t('toast_delivered_ok'), 'success');
    closeModal();
    loadMyOrders();
  } catch (e) {
    if (e.message && e.message.includes('verification')) toast(t('toast_auto_fail'), 'error', 6000);
    else toast(friendlyError(e.message), 'error');
    closeModal();
    loadMyOrders();
  }
}

async function confirmOrder(orderId) {
  if (!confirm(t('confirm_complete_q'))) return;
  try {
    const r = await api('/orders/' + orderId + '/confirm', { method: 'POST', headers: authHeaders() });
    toast(t('complete_toast_prefix') + r.seller_received + ' USDC ' + t('complete_toast_fee') + r.platform_fee + ')', 'success', 5000);
    loadMyOrders();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

// Dispute with confirmation modal
async function confirmDispute(orderId) {
  const confirmed = await confirmAction({
    title: currentLang === 'en' ? 'Open a Dispute' : '開啟爭議',
    message: currentLang === 'en'
      ? 'Are you sure? This cannot be undone. The order will be flagged for arbitration.'
      : '確定嗎？此操作無法撤銷。訂單將被標記為仲裁。',
    confirmText: currentLang === 'en' ? 'Open Dispute' : '開啟爭議',
    danger: true
  });
  if (!confirmed) return;
  openDisputeModal(orderId);
}

function openDisputeModal(orderId) {
  modal(`
    <button class="close" onclick="closeModal()">×</button>
    <h2>${t('dispute_title')}</h2>
    <p class="mdesc">${t('dispute_desc')}</p>
    <label>${t('dispute_reason')}</label>
    <textarea id="dis-reason" class="plain" placeholder="${t('dispute_reason_ph')}"></textarea>
    <label>${t('dispute_evidence')}</label>
    <textarea id="dis-ev" class="plain" placeholder="${t('dispute_evidence_ph')}"></textarea>
    <div class="btn-row">
      <button class="btn btn-danger" id="dispute-btn" onclick="doDispute('${orderId}')">${t('dispute_submit')}</button>
      <button class="btn btn-ghost" onclick="closeModal()">✕</button>
    </div>
  `);
}

function openArbitrateModal(orderId) {
  modal(`
    <button class="close" onclick="closeModal()">×</button>
    <h2>${t('arbitrate_title')}</h2>
    <p class="mdesc">${t('arbitrate_desc')}</p>
    <div class="keybox" style="margin-bottom:16px;">${t('arbitrate_info')}</div>
    <div class="btn-row">
      <button class="btn btn-primary" onclick="doAutoArbitrate('${orderId}')">${t('arbitrate_submit')}</button>
      <button class="btn btn-ghost" onclick="closeModal()">✕</button>
    </div>
  `);
}

async function doAutoArbitrate(orderId) {
  try {
    toast(t('toast_arbitrating'), 'info');
    closeModal();
    const r = await api('/orders/' + orderId + '/auto-arbitrate', { method: 'POST', headers: authHeaders() });
    const conf = Math.round((r.confidence || 0) * 100);
    modal(`
      <button class="close" onclick="closeModal()">×</button>
      <h2>${t('arbitrate_result')}</h2>
      <div class="keybox" style="margin-bottom:12px;">
        <b>${r.winner === 'buyer' ? t('verdict_buyer') : t('verdict_seller')}</b><br>
        <b>${currentLang==='en'?'Confidence':'信心度'}：${conf}%</b><br><br>
        ${escapeHtml(r.ai_reasoning)}
      </div>
      <div class="small">${currentLang==='en'?'Rep penalty':'信用扣分'}：-${r.reputation_penalty} · ${currentLang==='en'?'Stake slashed':'質押沒收'}：${r.stake_slashed}</div>
      <button class="btn btn-primary" style="margin-top:16px;" onclick="closeModal();loadMyOrders();">OK</button>
    `);
    loadMyOrders();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}
async function doDispute(orderId) {
  const reason = document.getElementById('dis-reason').value;
  const evidence = document.getElementById('dis-ev').value;
  if (!reason) return toast(t('toast_dispute_reason'), 'warn');
  const btn = document.getElementById('dispute-btn');
  btnLoading(btn, 'Submitting...');
  try {
    await api('/orders/' + orderId + '/dispute', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ reason, evidence: evidence || undefined }) });
    toast(t('toast_dispute_opened'), 'success');
    closeModal();
    loadMyOrders();
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
}

async function viewOrderDetail(orderId) {
  try {
    const o = await api('/orders/' + orderId, { headers: authHeaders() });
    const timeline = [
      { key: 'created',   label: t('detail_created'),   when: o.created_at,   done: true, active: false },
      { key: 'paid',      label: t('detail_paid'), when: o.created_at,   done: ['paid','delivered','completed','disputed','refunded'].includes(o.status), active: o.status === 'paid' },
      { key: 'delivered', label: t('detail_delivered'),   when: o.delivery?.delivered_at, done: ['delivered','completed','disputed'].includes(o.status), active: o.status === 'delivered' },
      { key: 'completed', label: t('detail_completed'),   when: o.completed_at, done: ['completed','refunded'].includes(o.status), active: o.status === 'completed' },
    ];
    modal(`
      <button class="close" onclick="closeModal()">×</button>
      <h2>${t('detail_title')}</h2>
      <p class="mdesc">${escapeHtml(o.service_name)} · ${money(o.amount)} USDC · <span class="st st-${o.status}">${statusLabel(o.status)}</span></p>
      <h3>${t('detail_progress')}</h3>
      <ul class="timeline">
        ${timeline.map(tl => `<li class="${tl.done ? 'done' : ''} ${tl.active ? 'active' : ''}"><b>${tl.label}</b><div class="t">${tl.when || '—'}</div></li>`).join('')}
      </ul>
      ${o.requirements ? `<h3>${t('detail_req')}</h3><div class="keybox" style="white-space:pre-wrap;">${escapeHtml(o.requirements)}</div>` : ''}
      ${o.delivery ? `<h3>${t('detail_delivery')}</h3><div class="keybox" style="white-space:pre-wrap;">${escapeHtml(o.delivery.content)}</div>` : ''}
      ${o.parent_order_id ? `<div class="small" style="margin-top:10px;">${t('detail_parent')} <code style="font-family:monospace">${o.parent_order_id}</code></div>` : ''}
      <div class="small" style="margin-top:8px;">${t('detail_buyer')} <code style="font-family:monospace">${o.buyer_name}</code> · ${t('detail_seller')} <code style="font-family:monospace">${o.seller_name}</code></div>
    `);
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

// ================= Subscriptions =================
async function loadSubscriptions() {
  const el = document.getElementById('sub-list');
  if (!el) return;
  if (!getIdentity()) { el.innerHTML = `<p class="muted">${t('ord_please_login')}</p>`; return; }
  showSkeleton(el, 2);
  try {
    const r = await api('/subscriptions', { headers: authHeaders() });
    if (!r.subscriptions?.length) { el.innerHTML = `<p class="muted">${t('ord_no_subs')}</p>`; return; }
    el.innerHTML = r.subscriptions.map(s => `
      <div class="order">
        <div class="top">
          <div>
            <div class="name">${escapeHtml(s.service_name)}</div>
            <div class="role">${s.buyer_id === getIdentity().id ? t('sub_subscriber') : t('sub_provider')} · ${s.interval === 'daily' ? t('int_daily') : s.interval === 'weekly' ? t('int_weekly') : t('int_monthly')} ${money(s.price)} USDC</div>
          </div>
          <span class="st st-${s.status === 'active' ? 'paid' : 'refunded'}">${s.status === 'active' ? t('sub_active') : s.status === 'cancelled' ? t('sub_cancelled') : s.status}</span>
        </div>
        <div class="small" style="margin-top:8px;">${t('sub_next')} ${s.next_billing_at ? new Date(s.next_billing_at).toLocaleString() : '—'}</div>
        <div class="actions" style="margin-top:10px;">
          ${s.status === 'active' && s.buyer_id === getIdentity().id
            ? `<button class="btn btn-danger btn-sm" onclick="confirmCancelSubscription('${s.id}')">${t('sub_cancel_btn')}</button>`
            : ''}
        </div>
      </div>
    `).join('');
  } catch (e) { el.innerHTML = renderErrorWithRetry(e.message, loadSubscriptions); }
}

// Cancel subscription with confirmation
async function confirmCancelSubscription(subId) {
  const confirmed = await confirmAction({
    title: currentLang === 'en' ? 'Cancel Subscription' : '取消訂閱',
    message: currentLang === 'en'
      ? 'You will lose access after the current billing period ends. This cannot be undone.'
      : '當前計費週期結束後您將失去存取權限。此操作無法撤銷。',
    confirmText: currentLang === 'en' ? 'Cancel Subscription' : '取消訂閱',
    danger: true
  });
  if (!confirmed) return;
  cancelSubscription(subId);
}

async function cancelSubscription(subId) {
  try {
    await api('/subscriptions/' + subId + '/cancel', { method: 'POST', headers: authHeaders() });
    toast(t('toast_sub_cancel'), 'success');
    loadSubscriptions();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function subscribeToService(serviceId) {
  try {
    const r = await api('/subscriptions', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ service_id: serviceId })
    });
    toast(t('toast_sub_success') + ' ' + new Date(r.next_billing_at).toLocaleDateString(), 'success');
    // Navigate to Orders panel → My Subscriptions subtab
    showPanel('orders');
    const subsBtn = document.querySelector('.subtab-btn[onclick*="ord-subs"]');
    if (subsBtn) switchSubTab(subsBtn, 'ord-subs');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

// ================= Inbox =================
async function loadInbox() {
  const el = document.getElementById('inbox-list');
  if (!el) return;
  if (!getIdentity()) { el.innerHTML = `<p class="muted">${t('ord_please_login')}</p>`; return; }
  showSkeleton(el, 3);
  try {
    const r = await api('/messages', { headers: authHeaders() });
    updateInboxBadge(r.unread || 0);
    if (!r.messages?.length) { el.innerHTML = `<p class="muted">${t('inbox_empty')}</p>`; return; }
    el.innerHTML = r.messages.map(m => `
      <div class="order" style="${!m.is_read && m.is_read !== 1 ? 'border-left:3px solid var(--accent)' : ''}">
        <div class="top" style="cursor:pointer" onclick="openMessage('${m.id}', this)">
          <div>
            <div class="name" style="font-weight:${!m.is_read && m.is_read !== 1 ? '700' : '400'}">${escapeHtml(m.subject || 'Message')}</div>
            <div class="role">${escapeHtml(m.sender_name || 'System')} · ${new Date(m.created_at).toLocaleString()}</div>
          </div>
          <span class="st ${!m.is_read && m.is_read !== 1 ? 'st-paid' : 'st-completed'}">${!m.is_read && m.is_read !== 1 ? t('inbox_unread') : 'read'}</span>
        </div>
        <div class="msg-body" id="msg-body-${m.id}" style="display:none;margin-top:12px;font-size:13px;line-height:1.6;border-top:1px solid var(--border);padding-top:12px">
          ${(() => {
            const dlMatch = m.body.match(/Download: (\/files\/[^\n]+)/);
            if (dlMatch) {
              const dlUrl = dlMatch[1];
              const apiKey = getAuth().key || '';
              return `<div style="white-space:pre-wrap">${escapeHtml(m.body)}</div>
                <div style="margin-top:12px">
                  <a href="${dlUrl}" download
                     onclick="event.preventDefault(); downloadFile('${dlUrl}', this)"
                     class="btn btn-primary btn-sm">Download File</a>
                </div>`;
            }
            return `<div style="white-space:pre-wrap">${escapeHtml(m.body)}</div>`;
          })()}
        </div>
      </div>
    `).join('');
  } catch (e) { el.innerHTML = renderErrorWithRetry(e.message, loadInbox); }
}

async function openMessage(msgId, headerEl) {
  const bodyEl = document.getElementById('msg-body-' + msgId);
  if (!bodyEl) return;
  const isOpen = bodyEl.style.display !== 'none';
  bodyEl.style.display = isOpen ? 'none' : 'block';
  if (!isOpen) {
    try {
      await api('/messages/' + msgId + '/read', { method: 'POST', headers: authHeaders() });
      headerEl.closest('.order').style.borderLeft = '';
      headerEl.querySelector('.name').style.fontWeight = '400';
      headerEl.querySelector('.st').className = 'st st-completed';
      headerEl.querySelector('.st').textContent = 'read';
      // Update badge
      const r = await api('/messages', { headers: authHeaders() });
      updateInboxBadge(r.unread || 0);
    } catch (e) {}
  }
}

async function markAllRead() {
  if (!getIdentity()) return;
  try {
    await api('/messages/read-all', { method: 'POST', headers: authHeaders() });
    loadInbox();
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function downloadFile(url, btn) {
  try {
    btn.textContent = 'Downloading...';
    btn.disabled = true;
    const res = await fetch(url, { headers: authHeaders() });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error || 'Download failed'); }
    const blob = await res.blob();
    const cd = res.headers.get('content-disposition') || '';
    const fnMatch = cd.match(/filename="([^"]+)"/);
    const filename = fnMatch ? fnMatch[1] : url.split('/').pop();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    btn.textContent = 'Download File';
    btn.disabled = false;
  } catch (e) { toast(friendlyError(e.message), 'error'); btn.textContent = 'Download File'; btn.disabled = false; }
}

function updateInboxBadge(count) {
  const badge = document.getElementById('inbox-badge');
  if (!badge) return;
  if (count > 0) { badge.textContent = count; badge.style.display = 'inline-block'; }
  else { badge.style.display = 'none'; }
}

async function refreshInboxBadge() {
  if (!getIdentity()) return;
  try {
    const r = await api('/messages', { headers: authHeaders() });
    updateInboxBadge(r.unread || 0);
  } catch (e) {}
}

// ================= Sub-delegation =================
async function openSubdelegateModal(orderId) {
  try {
    const svcs = await api('/services/search?sort=reputation');
    const myId = getIdentity()?.id;
    const options = (svcs.services || [])
      .filter(s => s.agent_id !== myId)
      .map(s => `<option value="${s.id}">${escapeHtml(s.name)} — ${money(s.price)} USDC (${escapeHtml(s.agent_name)})</option>`)
      .join('');
    if (!options) return toast(t('toast_no_subdelegate'), 'warn');
    modal(`
      <button class="close" onclick="closeModal()">×</button>
      <h2>${t('subdelegate_title')}</h2>
      <p class="mdesc">${t('subdelegate_desc')}</p>
      <label>${t('subdelegate_select')}</label>
      <select id="sub-svc" class="plain"><option value="">--</option>${options}</select>
      <label>${t('subdelegate_req_label')}</label>
      <textarea id="sub-req" class="plain" placeholder="${t('subdelegate_req_ph')}"></textarea>
      <div class="btn-row">
        <button class="btn btn-primary" id="subdelegate-btn" onclick="doSubdelegate('${orderId}')">${t('subdelegate_submit')}</button>
        <button class="btn btn-ghost" onclick="closeModal()">✕</button>
      </div>
    `);
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

async function doSubdelegate(orderId) {
  const svcId = document.getElementById('sub-svc').value;
  const req = document.getElementById('sub-req').value;
  if (!svcId) return toast(currentLang==='en'?'Please select a service':'請選擇服務', 'warn');
  const btn = document.getElementById('subdelegate-btn');
  btnLoading(btn, 'Processing...');
  try {
    const r = await api('/orders/' + orderId + '/subdelegate', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ service_id: svcId, requirements: req || undefined })
    });
    toast(t('toast_subdelegate_success'), 'success');
    closeModal();
    modal(`
      <button class="close" onclick="closeModal()">×</button>
      <h2>${t('subdelegate_success')}</h2>
      <div class="keybox">
        <b>${t('sub_child_id')}</b> ${r.child_order_id}<br>
        <b>${t('sub_service')}</b> ${escapeHtml(r.sub_service)}<br>
        <b>${t('sub_amount')}</b> ${money(r.amount)} USDC<br>
        <b>${t('sub_deadline')}</b> ${r.deadline}
      </div>
      <p class="mdesc" style="margin-top:12px">${t('sub_note')}</p>
      <button class="btn btn-primary" style="margin-top:12px;" onclick="closeModal();loadMyOrders();">OK</button>
    `);
    loadMyOrders();
  } catch (e) { toast(friendlyError(e.message), 'error'); btnRestore(btn); }
}

// ================= Leaderboard =================
async function loadLeaderboard() {
  const list = document.getElementById('lb-list');
  showSkeleton(list, 5);
  try {
    const r = await api('/agents/leaderboard');
    if (!r.agents.length) { list.innerHTML = `<div class="muted">${t('lb_no_data')}</div>`; return; }
    list.innerHTML = r.agents.map((a, i) => {
      const rank = i + 1;
      const medalClass = rank === 1 ? 'gold' : rank === 2 ? 'silver' : rank === 3 ? 'bronze' : '';
      const rankEl = medalClass
        ? `<div class="rank-medal ${medalClass}">${rank}</div>`
        : `<div class="rank">${rank}</div>`;
      return `
        <div class="lb">
          ${rankEl}
          <div class="lb-name">
            <div class="name">${escapeHtml(a.name)}</div>
            <div class="meta">${a.completed_sales || 0} ${t('lb_sales')}</div>
          </div>
          <div class="score">${t('lb_rep')} ${a.reputation_score}</div>
        </div>`;
    }).join('');
  } catch (e) { document.getElementById('lb-list').innerHTML = renderErrorWithRetry(e.message, loadLeaderboard); }
}

// ================= Bundle builder =================
async function loadBundleSelect() {
  try {
    const r = await api('/services/search?sort=reputation');
    const sel = document.getElementById('b-svc-select');
    sel.innerHTML = r.services.map(s => `<option value="${s.id}" data-name="${escapeHtml(s.name)}" data-price="${s.price}" data-seller="${escapeHtml(s.agent_name)}">${escapeHtml(s.name)} — ${money(s.price)} USDC · ${escapeHtml(s.agent_name)}</option>`).join('');
    state.lastServices = r.services;
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}
function bundleAdd() {
  const sel = document.getElementById('b-svc-select');
  const opt = sel.selectedOptions[0];
  if (!opt) return;
  state.bundleItems.push({ service_id: opt.value, name: opt.dataset.name, price: parseFloat(opt.dataset.price), seller: opt.dataset.seller });
  renderBundle();
}
function bundleRemove(idx) { state.bundleItems.splice(idx, 1); renderBundle(); }
function bundleClear() { state.bundleItems = []; renderBundle(); }
function renderBundle() {
  const items = state.bundleItems;
  const total = items.reduce((s, i) => s + i.price, 0);
  document.getElementById('b-count').textContent = items.length;
  document.getElementById('b-total').textContent = money(total);
  document.getElementById('b-items').innerHTML = items.length === 0
    ? `<div class="muted">${t('ord_bundle_empty')}</div>`
    : items.map((it, i) => `
      <div class="bundle-item">
        <div><span class="name">${escapeHtml(it.name)}</span> <span class="small">— ${escapeHtml(it.seller)}</span></div>
        <div><b style="color:var(--success)">${money(it.price)} USDC</b> <button class="btn btn-ghost btn-sm" onclick="bundleRemove(${i})">${t('bundle_remove')}</button></div>
      </div>`).join('');
}
async function submitBundle() {
  if (!localStorage.getItem(K.key)) { toast(t('toast_please_login'), 'warn'); return; }
  if (state.bundleItems.length === 0) { toast(t('toast_bundle_empty'), 'warn'); return; }
  try {
    const r = await api('/orders/bundle', { method: 'POST', headers: authHeaders(), body: JSON.stringify({ items: state.bundleItems.map(i => ({ service_id: i.service_id })) }) });
    toast(r.count + ' ' + t('ord_bundle_items') + ', ' + money(r.total_amount) + ' USDC', 'success', 5000);
    state.bundleItems = [];
    renderBundle();
    showPanel('orders');
  } catch (e) { toast(friendlyError(e.message), 'error'); }
}

// ================= Settings =================
function loadSettingsForm() {
  const a = getAuth();
  if (a.id) document.getElementById('set-id').value = a.id;
  if (a.key) document.getElementById('set-key').value = a.key;
}
function saveIdentity() {
  const id = document.getElementById('set-id').value.trim();
  const key = document.getElementById('set-key').value.trim();
  if (!id || !key) return toast(t('toast_fill_both'), 'warn');
  setAuth(id, key, '');
  api('/agents/' + id, { headers: { 'X-API-Key': key } })
    .then(a => { if (a.name) { localStorage.setItem(K.name, a.name); updateIdBar(); } })
    .catch(() => {});
  toast(t('toast_saved'), 'success');
}
function clearIdentity() {
  if (!confirm(t('confirm_logout_q'))) return;
  localStorage.removeItem(K.id); localStorage.removeItem(K.key); localStorage.removeItem(K.name);
  document.getElementById('set-id').value = '';
  document.getElementById('set-key').value = '';
  updateIdBar();
  toast(t('toast_logged_out'), 'success');
}
function toggleKeyVisible() {
  const el = document.getElementById('set-key');
  el.type = el.type === 'password' ? 'text' : 'password';
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
// Init theme from localStorage, default dark
applyTheme(localStorage.getItem('theme') || 'dark');

// ================= Init =================
applyTranslations();
updateIdBar();
loadStats();
if (!localStorage.getItem(K.onboarded) && !localStorage.getItem(K.id)) {
  setTimeout(() => document.getElementById('onboard').classList.add('show'), 300);
}
renderBundle();
// Poll inbox badge every 60 seconds
setTimeout(refreshInboxBadge, 2000);
setInterval(refreshInboxBadge, 60000);
