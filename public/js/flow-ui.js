// Arbitova — flow UI helpers.
//
// FlowUI.preflight({ key, title, steps })  → Promise<boolean>
//   Shows an inline modal explaining how many wallet popups the user is
//   about to see, and why. Once dismissed for a given `key` the same
//   preflight won't show again this session (sessionStorage).
//
// FlowUI.receipt(container, data)  → renders an inline success card
//   data: { action, escrowId?, txHash, explorerTx?, actions?: [{label, href}] }
//
// No dependencies beyond the browser.

(function () {
  'use strict';

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'style') Object.assign(node.style, props[k]);
      else if (k.startsWith('on')) node.addEventListener(k.slice(2).toLowerCase(), props[k]);
      else if (k === 'html') node.innerHTML = props[k];
      else node.setAttribute(k, props[k]);
    }
    for (const c of children) {
      if (c == null) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  }

  function injectStyles() {
    if (document.getElementById('flow-ui-styles')) return;
    const s = document.createElement('style');
    s.id = 'flow-ui-styles';
    s.textContent = `
      .fu-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.55); display: flex; align-items: center; justify-content: center; z-index: 9000; padding: 20px; }
      .fu-modal { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); max-width: 460px; width: 100%; padding: 26px 24px; color: var(--text-primary); font-family: var(--font-ui); }
      .fu-modal h3 { font-size: 17px; font-weight: 600; margin: 0 0 8px; }
      .fu-modal .sub { font-size: 13px; color: var(--text-secondary); line-height: 1.6; margin: 0 0 18px; }
      .fu-step-list { list-style: none; padding: 0; margin: 0 0 20px; counter-reset: fu; }
      .fu-step-list li { counter-increment: fu; position: relative; padding: 10px 12px 10px 40px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); margin-bottom: 8px; font-size: 13px; line-height: 1.5; background: var(--bg-base); }
      .fu-step-list li::before { content: counter(fu); position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 22px; height: 22px; border-radius: 50%; background: var(--brand-dim); color: var(--brand); font-size: 11px; font-weight: 700; font-family: var(--font-mono); display: flex; align-items: center; justify-content: center; }
      .fu-step-list li strong { display: block; color: var(--text-primary); font-weight: 600; font-size: 13px; margin-bottom: 2px; }
      .fu-step-list li span { color: var(--text-secondary); font-size: 12.5px; }
      .fu-row { display: flex; gap: 10px; justify-content: flex-end; align-items: center; }
      .fu-check { margin-right: auto; font-size: 12px; color: var(--text-tertiary); display: flex; align-items: center; gap: 6px; cursor: pointer; }
      .fu-btn { font: inherit; padding: 9px 18px; border-radius: var(--radius-sm); border: 1px solid var(--border-strong); background: transparent; color: var(--text-primary); cursor: pointer; font-size: 13px; font-weight: 500; }
      .fu-btn-primary { background: var(--brand); border-color: var(--brand); color: #000; }
      .fu-btn-primary:hover { background: var(--brand-hover); }

      .fu-receipt { background: var(--bg-surface); border: 1px solid var(--brand-border, var(--brand)); border-radius: var(--radius-md); padding: 20px 22px; margin-top: 16px; }
      .fu-receipt .fu-r-top { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
      .fu-receipt .fu-r-check { width: 26px; height: 26px; border-radius: 50%; background: var(--brand); color: #000; font-weight: 700; display: flex; align-items: center; justify-content: center; font-family: var(--font-mono); }
      .fu-receipt h4 { margin: 0; font-size: 15px; font-weight: 600; }
      .fu-receipt .fu-r-meta { font-size: 12px; font-family: var(--font-mono); color: var(--text-secondary); margin: 6px 0 12px; word-break: break-all; }
      .fu-receipt .fu-r-meta b { color: var(--text-primary); font-weight: 500; }
      .fu-receipt .fu-r-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
      .fu-receipt .fu-r-actions a { font-size: 12.5px; font-weight: 500; padding: 7px 12px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); color: var(--text-primary); text-decoration: none; }
      .fu-receipt .fu-r-actions a.primary { background: var(--brand); color: #000; border-color: var(--brand); }
    `;
    document.head.appendChild(s);
  }

  function preflight({ key, title, subtitle, steps, confirmLabel = 'Got it — show me the popups' }) {
    injectStyles();
    if (key) {
      try {
        if (sessionStorage.getItem('arbitova.preflight.' + key) === '1') {
          return Promise.resolve(true);
        }
      } catch {}
    }
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'fu-overlay';
      overlay.innerHTML = `
        <div class="fu-modal" role="dialog" aria-modal="true">
          <h3>${title || 'Before you sign'}</h3>
          <p class="sub">${subtitle || ''}</p>
          <ol class="fu-step-list">
            ${(steps || []).map((s) => `<li><strong>${s.title}</strong><span>${s.body || ''}</span></li>`).join('')}
          </ol>
          <div class="fu-row">
            ${key ? `<label class="fu-check"><input type="checkbox" id="fu-dont-show"> Don&rsquo;t show again this session</label>` : ''}
            <button class="fu-btn" data-action="cancel">Cancel</button>
            <button class="fu-btn fu-btn-primary" data-action="go">${confirmLabel}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.addEventListener('click', (e) => {
        const action = e.target.getAttribute && e.target.getAttribute('data-action');
        if (!action) return;
        const dontShow = overlay.querySelector('#fu-dont-show');
        if (action === 'go' && key && dontShow && dontShow.checked) {
          try { sessionStorage.setItem('arbitova.preflight.' + key, '1'); } catch {}
        }
        overlay.remove();
        resolve(action === 'go');
      });
    });
  }

  function receipt(container, { action, headline, escrowId, txHash, explorerTx, actions }) {
    injectStyles();
    if (typeof container === 'string') container = document.getElementById(container);
    if (!container) return;
    const shortTx = txHash ? `${txHash.slice(0, 10)}…${txHash.slice(-8)}` : '';
    const actionsHtml = (actions || []).map((a, i) =>
      `<a href="${a.href}" ${a.target ? `target="${a.target}" rel="noopener"` : ''} class="${i === 0 ? 'primary' : ''}">${a.label}</a>`
    ).join('');
    container.innerHTML = `
      <div class="fu-receipt" role="status">
        <div class="fu-r-top">
          <div class="fu-r-check">✓</div>
          <h4>${headline || (action + ' confirmed')}</h4>
        </div>
        <div class="fu-r-meta">
          ${escrowId ? `Escrow <b>#${escrowId}</b> &middot; ` : ''}
          ${txHash ? `Tx <b>${shortTx}</b>` : ''}
        </div>
        ${actionsHtml ? `<div class="fu-r-actions">${actionsHtml}</div>` : ''}
      </div>`;
  }

  window.FlowUI = { preflight, receipt };
})();
