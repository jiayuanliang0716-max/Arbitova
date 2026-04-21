// Arbitova — NextAction component.
//
// Given an escrow + the viewer's wallet address, renders a clear single-line
// "what do you do next?" card plus a 4-step progress bar:
//   CREATED → DELIVERED → REVIEWED → SETTLED
//
// No build step — drop-in global `NextAction` object used by status.html and
// review.html. Copy matrix is deliberately role-aware: a seller looking at a
// DELIVERED escrow waits; a buyer looking at the same escrow needs to act.

(function () {
  'use strict';

  function esc(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function roleOf(escrow, viewerAddr) {
    if (!viewerAddr) return 'other';
    const v = String(viewerAddr).toLowerCase();
    if (String(escrow.buyer).toLowerCase() === v) return 'buyer';
    if (String(escrow.seller).toLowerCase() === v) return 'seller';
    return 'other';
  }

  function deadlinePassed(ts) {
    return ts && Number(ts) * 1000 < Date.now();
  }

  // Copy matrix: (state, role) -> { urgency, headline, body, cta? }
  // urgency: 'action'  → viewer must act
  //          'wait'    → viewer is waiting on the other side
  //          'done'    → no action, informational
  function copyFor(escrow, role) {
    const st = escrow.state;
    const expiredDelivery = deadlinePassed(escrow.deliveryDeadline);
    const expiredReview = deadlinePassed(escrow.reviewDeadline);

    if (st === 'CREATED' && role === 'buyer') {
      if (expiredDelivery) {
        return { urgency: 'action', headline: 'Seller missed the delivery deadline — refund yourself',
          body: 'The delivery window expired without a delivery. You can call cancelIfNotDelivered to return every USDC to your wallet.',
          cta: { label: 'Cancel and refund', href: `/pay/review.html?id=${escrow.id}` } };
      }
      return { urgency: 'wait', headline: 'Waiting for the seller to deliver',
        body: `The seller has until ${new Date(Number(escrow.deliveryDeadline) * 1000).toLocaleString()} to deliver. If they don't, you can cancel and get a full refund.` };
    }
    if (st === 'CREATED' && role === 'seller') {
      return { urgency: 'action', headline: 'Deliver the work, then mark it on-chain',
        body: 'Complete the work off-chain (IPFS, HTTPS, anywhere), then call markDelivered with a hash of the payload URI. That starts the review window.',
        cta: { label: 'Mark delivered', href: '/pay/seller.html' } };
    }
    if (st === 'CREATED' && role === 'other') {
      return { urgency: 'done', headline: 'Awaiting delivery',
        body: 'This escrow is locked and waiting for the seller to mark delivered.' };
    }

    if (st === 'DELIVERED' && role === 'buyer') {
      if (expiredReview) {
        return { urgency: 'wait', headline: 'Review window closed — funds released automatically',
          body: 'You did not confirm in time. Anyone can now call escalateIfExpired and the contract will pay the seller.' };
      }
      return { urgency: 'action', headline: 'Review the delivery — confirm or dispute',
        body: `Confirm to release funds to the seller (minus 0.5% fee), or dispute if the work doesn't match. If you do nothing by ${new Date(Number(escrow.reviewDeadline) * 1000).toLocaleString()}, funds auto-release to the seller.`,
        cta: { label: 'Review delivery', href: `/pay/review.html?id=${escrow.id}` } };
    }
    if (st === 'DELIVERED' && role === 'seller') {
      if (expiredReview) {
        return { urgency: 'action', headline: 'Buyer silent — collect your payout',
          body: 'The review window has expired. Anyone (including you) can call escalateIfExpired to release the funds to you, minus the 0.5% fee.',
          cta: { label: 'Trigger auto-release', href: '/pay/seller.html' } };
      }
      return { urgency: 'wait', headline: 'Waiting for the buyer to confirm or dispute',
        body: `The buyer has until ${new Date(Number(escrow.reviewDeadline) * 1000).toLocaleString()} to act. If they do nothing, anyone can trigger auto-release and you'll be paid.` };
    }
    if (st === 'DELIVERED' && role === 'other') {
      return { urgency: 'done', headline: 'Delivered — under review',
        body: 'The buyer is reviewing the delivery. They can confirm (release) or dispute.' };
    }

    if (st === 'DISPUTED') {
      return { urgency: 'wait', headline: 'Arbiter is resolving the dispute',
        body: 'Target resolve time: 72h. The arbiter reviews the verification URI, the delivery payload, and the dispute reason, then writes a split on-chain. Every verdict is published.',
        cta: { label: 'See how disputes are handled', href: '/arbiter' } };
    }

    if (st === 'RESOLVED') {
      return { urgency: 'done', headline: 'Settled by the arbiter',
        body: 'The arbiter split the funds and wrote the verdict hash on-chain. See /verdicts for the full reasoning.',
        cta: { label: 'View verdict log', href: '/verdicts' } };
    }

    if (st === 'RELEASED') {
      return { urgency: 'done', headline: 'Released — seller paid in full',
        body: 'The happy path completed. Seller received the amount minus the 0.5% release fee. No further action possible.' };
    }

    if (st === 'CANCELLED') {
      return { urgency: 'done', headline: 'Cancelled — buyer refunded',
        body: 'The seller did not deliver in time. Buyer received a full refund. No further action possible.' };
    }

    return { urgency: 'done', headline: escrow.state || 'Unknown state', body: '' };
  }

  // 4-step progress bar. Each escrow state maps to a step index (1..4).
  // 1 CREATED, 2 DELIVERED, 3 REVIEWED (confirm OR dispute opened), 4 SETTLED
  function stepIndex(state) {
    switch (state) {
      case 'CREATED':   return 1;
      case 'DELIVERED': return 2;
      case 'DISPUTED':  return 3;
      case 'RESOLVED':
      case 'RELEASED':
      case 'CANCELLED': return 4;
      default:          return 1;
    }
  }

  function renderProgressBar(state) {
    const cur = stepIndex(state);
    const steps = [
      { n: 1, label: 'Created' },
      { n: 2, label: 'Delivered' },
      { n: 3, label: 'Reviewed' },
      { n: 4, label: 'Settled' },
    ];
    return `
      <div class="na-progress" aria-label="Escrow progress">
        ${steps.map((s, i) => {
          const done = s.n < cur;
          const active = s.n === cur;
          return `
            <div class="na-step ${done ? 'done' : ''} ${active ? 'active' : ''}">
              <div class="na-dot">${done ? '✓' : s.n}</div>
              <div class="na-label">${s.label}</div>
            </div>
            ${i < steps.length - 1 ? '<div class="na-line"></div>' : ''}
          `;
        }).join('')}
      </div>
      <style>
        .na-progress { display: flex; align-items: center; gap: 8px; margin: 16px 0 20px; padding: 12px 0; }
        .na-step { display: flex; flex-direction: column; align-items: center; gap: 6px; min-width: 56px; }
        .na-dot { width: 28px; height: 28px; border-radius: 50%; background: var(--bg-surface); border: 1.5px solid var(--border-default); color: var(--text-secondary); font-size: 12px; font-weight: 600; display: flex; align-items: center; justify-content: center; font-family: var(--font-mono); }
        .na-step.done .na-dot { background: var(--brand-dim); border-color: var(--brand); color: var(--brand); }
        .na-step.active .na-dot { background: var(--brand); border-color: var(--brand); color: #000; }
        .na-label { font-size: 11px; color: var(--text-tertiary); font-weight: 500; }
        .na-step.done .na-label, .na-step.active .na-label { color: var(--text-primary); }
        .na-line { flex: 1; height: 1.5px; background: var(--border-subtle); margin: 0 2px; margin-bottom: 22px; }
      </style>
    `;
  }

  function renderCard(escrow, viewerAddr) {
    const role = roleOf(escrow, viewerAddr);
    const copy = copyFor(escrow, role);
    const badge =
      copy.urgency === 'action' ? { text: 'Next step', color: 'var(--brand)', bg: 'var(--brand-dim)' } :
      copy.urgency === 'wait'   ? { text: 'Waiting',   color: 'var(--warning)', bg: 'var(--warning-bg)' } :
                                  { text: 'Info',      color: 'var(--text-secondary)', bg: 'var(--bg-surface)' };
    return `
      ${renderProgressBar(escrow.state)}
      <div class="na-card" data-state="${esc(escrow.state)}" data-role="${esc(role)}" data-urgency="${esc(copy.urgency)}">
        <div class="na-header">
          <span class="na-badge" style="color:${badge.color};background:${badge.bg}">${badge.text}</span>
          <span class="na-role">You&rsquo;re the ${role === 'other' ? 'observer' : role}</span>
        </div>
        <h3 class="na-headline">${esc(copy.headline)}</h3>
        <p class="na-body">${esc(copy.body)}</p>
        ${copy.cta ? `<a class="na-cta" href="${esc(copy.cta.href)}">${esc(copy.cta.label)} &rarr;</a>` : ''}
      </div>
      <style>
        .na-card { background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 20px 22px; margin-bottom: 16px; }
        .na-card[data-urgency="action"] { border-color: var(--brand-border); }
        .na-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
        .na-badge { font-size: 10.5px; font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.08em; padding: 3px 10px; border-radius: var(--radius-full); font-weight: 600; }
        .na-role { font-size: 11px; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.06em; }
        .na-headline { font-size: 16px; font-weight: 600; margin: 0 0 8px; line-height: 1.4; }
        .na-body { font-size: 13px; color: var(--text-secondary); line-height: 1.65; margin: 0 0 14px; }
        .na-cta { display: inline-block; font-size: 13px; font-weight: 500; color: var(--brand); }
      </style>
    `;
  }

  function mount(container, escrow, viewerAddr) {
    if (!container) return;
    container.innerHTML = renderCard(escrow, viewerAddr);
  }

  window.NextAction = { render: renderCard, mount, progressBar: renderProgressBar };
})();
