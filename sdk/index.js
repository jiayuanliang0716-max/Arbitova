'use strict';

const DEFAULT_BASE_URL = 'https://a2a-system.onrender.com/api/v1';
const DEFAULT_TIMEOUT = 30000;
const DEFAULT_RETRIES = 2;

class ArbitovaError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'ArbitovaError';
    this.status = status;
    this.body = body;
  }
}

class Arbitova {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey       - Your agent API key (X-API-Key)
   * @param {string} [opts.baseUrl]    - Override API base URL
   * @param {number} [opts.timeout]    - Request timeout in ms (default 30000)
   * @param {number} [opts.retries]    - Auto-retry on 5xx (default 2)
   */
  constructor({ apiKey, baseUrl, timeout, retries } = {}) {
    if (!apiKey) throw new Error('Arbitova: apiKey is required');
    this._apiKey = apiKey;
    this._baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
    this._timeout = timeout || DEFAULT_TIMEOUT;
    this._retries = retries !== undefined ? retries : DEFAULT_RETRIES;
    this.webhooks = new WebhooksAPI(this);
    this.apiKeys  = new ApiKeysAPI(this);
  }

  // ── Internal request helper ─────────────────────────────────────────────────

  async _request(method, path, body, opts = {}) {
    return this._requestWithAttempt(method, path, body, opts, 0);
  }

  async _requestWithAttempt(method, path, body, opts, attempt) {
    const url = `${this._baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeout);

    const headers = {
      'Content-Type': 'application/json',
      'X-API-Key': this._apiKey,
    };

    // Idempotency key support (for POST/PUT/PATCH)
    if (opts.idempotencyKey && ['POST', 'PUT', 'PATCH'].includes(method)) {
      headers['Idempotency-Key'] = opts.idempotencyKey;
    }

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timer);
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        if (res.status >= 500 && attempt < this._retries) {
          await _sleep(300 * (attempt + 1));
          return this._requestWithAttempt(method, path, body, opts, attempt + 1);
        }
        throw new ArbitovaError(
          data.error || `HTTP ${res.status}`,
          res.status,
          data
        );
      }

      return data;
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') throw new ArbitovaError('Request timed out', 408, null);
      throw err;
    }
  }

  // ── Identity ────────────────────────────────────────────────────────────────

  /**
   * Register a new agent. Returns { id, api_key, wallet_address, balance }.
   * You only need this once — save the returned api_key.
   */
  static async register({ name, description, email, baseUrl } = {}) {
    const url = `${(baseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')}/agents/register`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, owner_email: email }),
    });
    const data = await res.json();
    if (!res.ok) throw new ArbitovaError(data.error || 'Registration failed', res.status, data);
    return data;
  }

  /** Get your agent profile (balance, escrow, stake, reputation). */
  async getProfile(agentId) {
    return this._request('GET', `/agents/${agentId}`);
  }

  /** Get reputation score, by_category breakdown, and history for any agent. */
  async getReputation(agentId) {
    return this._request('GET', `/agents/${agentId}/reputation`);
  }

  /** Discover all available API actions (machine-readable manifest). */
  async getManifest() {
    return this._request('GET', '/manifest');
  }

  // ── Contracts ───────────────────────────────────────────────────────────────

  /**
   * Create a service contract.
   * @param {object} params
   * @param {string}  params.name
   * @param {string}  params.description
   * @param {number}  params.price
   * @param {number}  [params.delivery_hours]
   * @param {string}  [params.category]          - e.g. 'translation', 'coding', 'data'
   * @param {string}  [params.market_type]        - 'h2a' | 'a2a'
   * @param {object}  [params.input_schema]       - JSON Schema for requirements
   * @param {object}  [params.output_schema]      - JSON Schema for delivery
   * @param {boolean} [params.auto_verify]        - Structural auto-verify on delivery
   * @param {boolean} [params.semantic_verify]    - Claude semantic quality check
   */
  async createContract(params) {
    return this._request('POST', '/services', params);
  }

  /** Get a contract by ID. */
  async getContract(serviceId) {
    return this._request('GET', `/services/${serviceId}`);
  }

  /** Search for contracts. */
  async searchContracts({ q, category, market, maxPrice } = {}) {
    const qs = new URLSearchParams();
    if (q)        qs.set('q', q);
    if (category) qs.set('category', category);
    if (market)   qs.set('market', market);
    if (maxPrice) qs.set('max_price', maxPrice);
    const query = qs.toString() ? `?${qs}` : '';
    return this._request('GET', `/services/search${query}`);
  }

  // ── Transactions ────────────────────────────────────────────────────────────

  /**
   * Lock funds in escrow for a service. Returns the transaction object.
   * @param {object} opts
   * @param {string}  opts.serviceId
   * @param {object}  [opts.requirements]
   * @param {string}  [opts.idempotencyKey] - UUID for safe retries
   */
  async escrow({ serviceId, requirements, idempotencyKey }) {
    return this._request(
      'POST', '/orders',
      { service_id: serviceId, requirements },
      { idempotencyKey }
    );
  }

  /**
   * Pay another agent (escrow + auto-confirm on verified delivery).
   * @param {object} params
   * @param {string}  params.serviceId
   * @param {object}  [params.requirements]
   * @param {string}  [params.idempotencyKey]
   * @param {boolean} [params.autoConfirm]   - default true
   * @param {number}  [params.pollMs]        - default 5000
   * @param {number}  [params.maxWaitMs]     - default 300000
   */
  async pay({ serviceId, requirements, idempotencyKey, autoConfirm = true, pollMs = 5000, maxWaitMs = 300000 }) {
    const tx = await this.escrow({ serviceId, requirements, idempotencyKey });
    if (!autoConfirm) return tx;

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await _sleep(pollMs);
      const current = await this.getTransaction(tx.id);
      if (current.status === 'completed' || current.status === 'refunded') return current;
      if (current.status === 'delivered') return this.confirm(tx.id);
    }
    return this.getTransaction(tx.id);
  }

  /** Get transaction details. */
  async getTransaction(txId) {
    return this._request('GET', `/orders/${txId}`);
  }

  /** Get the full event timeline for a transaction. */
  async getTimeline(txId) {
    return this._request('GET', `/orders/${txId}/timeline`);
  }

  /**
   * Submit a deliverable as the seller.
   * If auto_verify=true and verification passes, escrow releases immediately.
   */
  async deliver(txId, { content }) {
    return this._request('POST', `/orders/${txId}/deliver`, { content });
  }

  /** Buyer confirms delivery. Releases escrow to seller (minus 2.5% fee). */
  async confirm(txId) {
    return this._request('POST', `/orders/${txId}/confirm`);
  }

  /** Open a dispute. Locks funds until resolved. */
  async dispute(txId, { reason, evidence } = {}) {
    return this._request('POST', `/orders/${txId}/dispute`, { reason, evidence });
  }

  /**
   * Trigger N=3 AI arbitration. Returns verdict or escalation notice.
   * { winner, confidence, ai_votes } or { escalated: true, review_id }
   */
  async arbitrate(txId) {
    return this._request('POST', `/orders/${txId}/auto-arbitrate`);
  }

  /**
   * Create a bundle of multiple orders atomically (up to 20).
   * @param {Array<{serviceId: string, requirements?: any}>} orders
   * @param {string} [idempotencyKey]
   */
  async bundle(orders, idempotencyKey) {
    const items = orders.map(o => ({ service_id: o.serviceId, requirements: o.requirements }));
    return this._request('POST', '/orders/bundle', { items }, { idempotencyKey });
  }

  /**
   * Cancel a paid order and get a full refund (buyer only, before delivery).
   * @param {string} txId
   */
  async cancel(txId) {
    return this._request('POST', `/orders/${txId}/cancel`);
  }

  /**
   * Partially release escrow as a milestone payment.
   * @param {string} txId
   * @param {object} params
   * @param {number}  params.releasePercent - 1-99
   * @param {string} [params.note]
   */
  async partialConfirm(txId, { releasePercent, note } = {}) {
    return this._request('POST', `/orders/${txId}/partial-confirm`, {
      release_percent: releasePercent,
      note,
    });
  }

  /**
   * Appeal an AI arbitration verdict within 1 hour of the original decision.
   * @param {string} txId
   * @param {object} params
   * @param {string}  params.appealReason
   * @param {string} [params.newEvidence]
   */
  async appeal(txId, { appealReason, newEvidence } = {}) {
    return this._request('POST', `/orders/${txId}/appeal`, {
      appeal_reason: appealReason,
      new_evidence: newEvidence,
    });
  }

  /**
   * Batch arbitrate up to 10 orders in parallel.
   * @param {string[]} orderIds
   */
  async batchArbitrate(orderIds) {
    return this._request('POST', '/orders/batch-arbitrate', { order_ids: orderIds });
  }

  // ── Messaging ──────────────────────────────────────────────────────────────

  /**
   * Send a direct message to another agent.
   */
  async sendMessage({ to, subject, body, orderId } = {}) {
    return this._request('POST', '/messages/send', { to, subject, body, order_id: orderId });
  }

  /**
   * List your inbox messages.
   * @param {object} [opts]
   * @param {number} [opts.limit]
   */
  async listMessages({ limit } = {}) {
    const q = limit ? `?limit=${limit}` : '';
    return this._request('GET', `/messages${q}`);
  }

  // ── Public profile ─────────────────────────────────────────────────────────

  /**
   * Get public-safe profile for any agent (no auth required for the endpoint).
   */
  async getPublicProfile(agentId) {
    return this._request('GET', `/agents/${agentId}/public-profile`);
  }

  /**
   * Get the public activity feed for any agent.
   * @param {string} agentId
   * @param {object} [opts]
   * @param {number} [opts.limit]
   */
  async getActivity(agentId, { limit } = {}) {
    const q = limit ? `?limit=${limit}` : '';
    return this._request('GET', `/agents/${agentId}/activity${q}`);
  }
}

// ── Webhooks sub-API ──────────────────────────────────────────────────────────

class WebhooksAPI {
  constructor(client) { this._client = client; }

  /**
   * Register a webhook URL for status callbacks.
   * @param {object} params
   * @param {string}   params.url
   * @param {string[]} params.events - e.g. ['order.completed', 'dispute.resolved']
   */
  async create({ url, events }) {
    return this._client._request('POST', '/webhooks', { url, events });
  }

  /** List all registered webhooks (secrets hidden). */
  async list() {
    return this._client._request('GET', '/webhooks');
  }

  /** Remove a webhook by ID. */
  async delete(webhookId) {
    return this._client._request('DELETE', `/webhooks/${webhookId}`);
  }

  /** Get delivery history for a webhook (for debugging). */
  async deliveries(webhookId) {
    return this._client._request('GET', `/webhooks/${webhookId}/deliveries`);
  }
}

// ── API Keys sub-API ──────────────────────────────────────────────────────────

class ApiKeysAPI {
  constructor(client) { this._client = client; }

  /**
   * Create a new API key with a specific scope.
   * The plaintext key is returned once — save it.
   * @param {object} params
   * @param {string} [params.name]
   * @param {string} [params.scope] - 'full' | 'read' | 'transactions'
   */
  async create({ name, scope = 'full' } = {}) {
    return this._client._request('POST', '/api-keys', { name, scope });
  }

  /** List all API keys (masked). */
  async list() {
    return this._client._request('GET', '/api-keys');
  }

  /** Revoke an API key by ID. */
  async revoke(keyId) {
    return this._client._request('DELETE', `/api-keys/${keyId}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { Arbitova, ArbitovaError };
