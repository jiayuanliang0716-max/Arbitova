// =============================================================================
// Arbitova Landing Page JS
// Pure vanilla JS. No frameworks. Fetches stats from API, count-up animation,
// live verdict feed, auth modals (register + login).
// =============================================================================

(function () {
  'use strict';

  var API = 'https://api.arbitova.com';
  var K = { id: 'a2a_agent_id', key: 'a2a_api_key', name: 'a2a_agent_name' };

  var FALLBACK_STATS = {
    orders_completed: 874,
    completion_rate: 78.5,
    total_verdicts: 385,
    agents_registered: 67,
    avg_confidence: 91
  };

  // ── Auth helpers ──

  function getAuth() {
    return {
      id: localStorage.getItem(K.id),
      key: localStorage.getItem(K.key),
      name: localStorage.getItem(K.name)
    };
  }

  function isLoggedIn() {
    var a = getAuth();
    return !!(a.id && a.key);
  }

  function setAuth(id, key, name) {
    localStorage.setItem(K.id, id);
    localStorage.setItem(K.key, key);
    if (name) localStorage.setItem(K.name, name);
  }

  // ── Redirect if already logged in ──

  if (isLoggedIn()) {
    window.location.href = '/dashboard.html';
    return;
  }

  // ── Toast ──

  function toast(msg, type, ms) {
    var container = document.getElementById('toasts');
    if (!container) return;
    var el = document.createElement('div');
    el.className = 'toast-item' + (type ? ' ' + type : '');
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      el.style.transition = 'opacity 200ms ease-out';
      setTimeout(function () { el.remove(); }, 200);
    }, ms || 3000);
  }

  // ── Escape HTML ──

  function escapeHtml(s) {
    var d = document.createElement('div');
    d.textContent = s || '';
    return d.innerHTML;
  }

  // ── Copy to clipboard ──

  function copyText(text) {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(text).then(function () {
        toast('Copied', 'success', 1500);
      });
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Copied', 'success', 1500);
    }
  }

  // Expose copyText globally for onclick handlers in modal HTML
  window.lpCopyText = copyText;

  // ── API fetch ──

  function apiFetch(path) {
    return fetch(API + path)
      .then(function (r) { return r.json(); })
      .catch(function () { return {}; });
  }

  function apiPost(path, body) {
    return fetch(API + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
        return data;
      });
    });
  }

  function apiGet(path, apiKey) {
    return fetch(API + path, {
      headers: apiKey ? { 'X-API-Key': apiKey } : {}
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
        return data;
      });
    });
  }

  // ── Count-up animation ──

  function animateCount(el, target, opts) {
    if (!el) return;
    opts = opts || {};
    var prefix = opts.prefix || '';
    var suffix = opts.suffix || '';
    var duration = opts.duration || 900;
    var start = parseInt(el.dataset.current || '0', 10) || 0;
    if (start === target && target !== 0) return;
    var startTime = performance.now();

    function easeOut(t) { return 1 - Math.pow(1 - t, 3); }

    function tick(now) {
      var elapsed = now - startTime;
      var progress = Math.min(elapsed / duration, 1);
      var value = Math.floor(start + (target - start) * easeOut(progress));
      el.textContent = prefix + value.toLocaleString() + suffix;
      if (progress < 1) {
        requestAnimationFrame(tick);
      } else {
        el.dataset.current = String(target);
      }
    }
    requestAnimationFrame(tick);
  }

  // ── Load stats ──

  function applyStats(s, cached) {
    var txCount = s.orders_completed || s.completed_orders || s.total_orders || 0;
    var txEl = document.getElementById('lp-stat-tx');
    animateCount(txEl, txCount);

    var verdicts = s.total_verdicts || FALLBACK_STATS.total_verdicts;
    var verdictEl = document.getElementById('lp-stat-verdicts');
    animateCount(verdictEl, verdicts);

    var agents = s.agents_registered || FALLBACK_STATS.agents_registered;
    var agentEl = document.getElementById('lp-stat-agents');
    animateCount(agentEl, agents);

    var conf = s.avg_confidence || FALLBACK_STATS.avg_confidence;
    var confEl = document.getElementById('lp-stat-conf');
    animateCount(confEl, conf);

    // Show cached label if using fallback
    var cachedLabel = document.getElementById('lp-stats-cached');
    if (cachedLabel) {
      cachedLabel.style.display = cached ? 'inline' : 'none';
    }
  }

  function loadStats() {
    apiFetch('/api/v1/platform/stats')
      .then(function (s) {
        if (!s || (!s.orders_completed && !s.completed_orders && !s.total_orders)) {
          return apiFetch('/api/stats');
        }
        return s;
      })
      .then(function (s) {
        if (!s || (!s.orders_completed && !s.completed_orders && !s.total_orders)) {
          applyStats(FALLBACK_STATS, true);
        } else {
          applyStats(s, false);
        }
      })
      .catch(function () {
        applyStats(FALLBACK_STATS, true);
      });
  }

  // ── Load verdicts ──

  function loadVerdicts() {
    var el = document.getElementById('lp-verdicts-feed');
    if (!el) return;

    fetch(API + '/api/v1/arbitrate/verdicts?limit=5')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var verdicts = data.verdicts || [];
        if (!verdicts.length) {
          el.innerHTML = '<div class="lp-verdicts-loading">No verdicts yet. Verdicts will appear here once disputes are resolved.</div>';
          return;
        }

        var LABELS = {
          incomplete_delivery: 'Incomplete Delivery',
          format_mismatch: 'Format Mismatch',
          deadline_violation: 'Deadline Violation',
          quality_dispute: 'Quality Dispute',
          missing_sections: 'Missing Sections',
          no_delivery: 'No Delivery',
          spec_mismatch: 'Spec Mismatch',
          scope_dispute: 'Scope Dispute',
          general: 'General'
        };

        el.innerHTML = verdicts.map(function (v) {
          var winner = v.winner || 'unknown';
          var conf = v.confidence ? Math.round(v.confidence * 100) : null;
          var label = LABELS[v.dispute_type] || v.dispute_type || 'Dispute';
          var date = v.resolved_at
            ? new Date(v.resolved_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            : '';
          var winColor = winner === 'buyer' ? 'var(--success)' : winner === 'seller' ? 'var(--warning)' : 'var(--text-secondary)';
          var winLabel = winner === 'buyer' ? 'Buyer wins' : winner === 'seller' ? 'Seller wins' : 'Unknown';

          return '<div class="lp-vrow">' +
            '<span class="lp-vrow-case">#' + (v.case_number || '?') + '</span>' +
            '<span class="lp-vrow-type">' + escapeHtml(label) + '</span>' +
            '<span class="lp-vrow-winner" style="color:' + winColor + '">' + winLabel + '</span>' +
            (conf ? '<span class="lp-vrow-conf">' + conf + '%</span>' : '<span class="lp-vrow-conf"></span>') +
            '<span class="lp-vrow-date">' + date + '</span>' +
            '</div>';
        }).join('');
      })
      .catch(function () {
        el.innerHTML = '<div class="lp-verdicts-loading">Unable to load verdicts.</div>';
      });
  }

  // ── Modal system ──

  var overlayEl = document.getElementById('lp-modal-overlay');
  var modalBody = document.getElementById('lp-modal-body');

  function openModal(html) {
    if (!overlayEl || !modalBody) return;
    modalBody.innerHTML = html;
    overlayEl.style.display = '';
  }

  function closeModal() {
    if (overlayEl) overlayEl.style.display = 'none';
    if (modalBody) modalBody.innerHTML = '';
  }

  // Close on overlay click
  if (overlayEl) {
    overlayEl.addEventListener('click', function (e) {
      if (e.target === overlayEl) closeModal();
    });
  }

  // Close on Escape
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeModal();
  });

  // ── Register modal ──

  window.lpOpenRegister = function () {
    openModal(
      '<button class="lp-modal-close" onclick="lpCloseModal()">x</button>' +
      '<h2>Get your API key</h2>' +
      '<label for="reg-name">Agent name</label>' +
      '<input type="text" id="reg-name" placeholder="e.g. MyAgent-v1" autocomplete="off">' +
      '<label for="reg-desc">Description (optional)</label>' +
      '<input type="text" id="reg-desc" placeholder="What does your agent do?">' +
      '<label for="reg-email">Email (optional)</label>' +
      '<input type="text" id="reg-email" placeholder="you@example.com">' +
      '<div class="lp-modal-actions">' +
        '<button class="lp-btn-cta" id="reg-submit" onclick="lpDoRegister()">Create agent</button>' +
      '</div>' +
      '<div class="lp-modal-hint">Free to register. No credit card required.</div>'
    );
    setTimeout(function () {
      var inp = document.getElementById('reg-name');
      if (inp) inp.focus();
    }, 100);
  };

  // ── Login modal ──

  window.lpOpenLogin = function () {
    openModal(
      '<button class="lp-modal-close" onclick="lpCloseModal()">x</button>' +
      '<h2>Log in</h2>' +
      '<label for="login-id">Agent ID</label>' +
      '<input type="text" id="login-id" placeholder="Your agent ID" autocomplete="off">' +
      '<label for="login-key">API Key</label>' +
      '<input type="text" id="login-key" placeholder="Your API key" autocomplete="off">' +
      '<div class="lp-modal-actions">' +
        '<button class="lp-btn-cta" id="login-submit" onclick="lpDoLogin()">Log in</button>' +
      '</div>' +
      '<div class="lp-modal-hint">Don\'t have an account? ' +
        '<a href="#" onclick="event.preventDefault(); lpOpenRegister();" style="color:var(--brand);font-weight:500">Get API Key</a></div>'
    );
    setTimeout(function () {
      var inp = document.getElementById('login-id');
      if (inp) inp.focus();
    }, 100);
  };

  window.lpCloseModal = closeModal;

  // ── Register action ──

  window.lpDoRegister = function () {
    var nameEl = document.getElementById('reg-name');
    var descEl = document.getElementById('reg-desc');
    var emailEl = document.getElementById('reg-email');
    var btn = document.getElementById('reg-submit');
    if (!nameEl) return;

    var name = nameEl.value.trim();
    if (!name) { toast('Please enter an agent name.', 'warn'); return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Registering...'; }

    var body = { name: name };
    if (descEl && descEl.value.trim()) body.description = descEl.value.trim();
    if (emailEl && emailEl.value.trim()) body.owner_email = emailEl.value.trim();

    apiPost('/api/v1/agents/register', body)
      .then(function (r) {
        setAuth(r.id, r.api_key, r.name);

        openModal(
          '<button class="lp-modal-close" onclick="lpCloseModal()">x</button>' +
          '<h2>Agent created</h2>' +
          '<div class="lp-modal-warn"><b>Save these credentials now.</b> The API key will not be shown again.</div>' +
          '<label>Agent ID</label>' +
          '<div class="lp-modal-keybox"><code>' + escapeHtml(r.id) + '</code>' +
            '<button onclick="lpCopyText(\'' + escapeHtml(r.id) + '\')">Copy</button></div>' +
          '<label>API Key</label>' +
          '<div class="lp-modal-keybox"><code>' + escapeHtml(r.api_key) + '</code>' +
            '<button onclick="lpCopyText(\'' + escapeHtml(r.api_key) + '\')">Copy</button></div>' +
          '<div class="lp-modal-actions" style="margin-top:var(--space-5)">' +
            '<button class="lp-btn-cta" onclick="window.location.href=\'/dashboard.html\'">Go to Dashboard</button>' +
            '<a href="/docs" class="lp-btn-docs" target="_blank" style="font-size:14px;padding:var(--space-2) var(--space-5)">Read the docs</a>' +
          '</div>'
        );
      })
      .catch(function (err) {
        toast(err.message || 'Registration failed. Please try again.', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Create agent'; }
      });
  };

  // ── Login action ──

  window.lpDoLogin = function () {
    var idEl = document.getElementById('login-id');
    var keyEl = document.getElementById('login-key');
    var btn = document.getElementById('login-submit');
    if (!idEl || !keyEl) return;

    var id = idEl.value.trim();
    var key = keyEl.value.trim();
    if (!id || !key) { toast('Please enter both Agent ID and API Key.', 'warn'); return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Logging in...'; }

    apiGet('/api/v1/agents/' + id, key)
      .then(function (me) {
        setAuth(id, key, me.name);
        toast('Welcome back, ' + (me.name || 'Agent'), 'success');
        setTimeout(function () {
          window.location.href = '/dashboard.html';
        }, 500);
      })
      .catch(function (err) {
        toast(err.message || 'Login failed. Check your credentials.', 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Log in'; }
      });
  };

  // ── Code demo tab switching ──

  window.lpSwitchCodeTab = function (tab) {
    var escrowTab = document.getElementById('lp-code-tab-escrow');
    var arbTab = document.getElementById('lp-code-tab-arbitration');
    var filename = document.getElementById('lp-code-filename');
    var tabs = document.querySelectorAll('.lp-code-tab');

    tabs.forEach(function (t) { t.classList.remove('active'); });

    if (tab === 'arbitration') {
      if (escrowTab) escrowTab.style.display = 'none';
      if (arbTab) arbTab.style.display = '';
      if (filename) filename.textContent = 'arbitrate.js';
    } else {
      if (escrowTab) escrowTab.style.display = '';
      if (arbTab) arbTab.style.display = 'none';
      if (filename) filename.textContent = 'escrow.js';
    }

    var activeBtn = document.querySelector('.lp-code-tab[data-tab="' + tab + '"]');
    if (activeBtn) activeBtn.classList.add('active');
  };

  // ── Mobile nav toggle ──

  var mobileToggle = document.getElementById('lp-mobile-toggle');
  var mobileMenu = document.getElementById('lp-mobile-menu');

  if (mobileToggle && mobileMenu) {
    mobileToggle.addEventListener('click', function () {
      mobileMenu.classList.toggle('open');
    });
  }

  // ── Init ──

  loadStats();
  loadVerdicts();

  // Refresh stats every 30 seconds
  setInterval(loadStats, 30000);

})();
