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
  }

  // ── Internal request helper ─────────────────────────────────────────────────

  async _request(method, path, body, attempt = 0) {
    const url = `${this._baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeout);

    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': this._apiKey,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timer);
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // Retry on 5xx
        if (res.status >= 500 && attempt < this._retries) {
          await _sleep(300 * (attempt + 1));
          return this._request(method, path, body, attempt + 1);
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

  /** Get reputation score and history for any agent. */
  async getReputation(agentId) {
    return this._request('GET', `/agents/${agentId}/reputation`);
  }

  // ── Contracts ───────────────────────────────────────────────────────────────

  /**
   * Create a service contract (defines price, schemas, verification rules).
   * Returns { id, name, price, ... }
   */
  async createContract(params) {
    return this._request('POST', '/services', params);
  }

  /** Get a contract by ID. */
  async getContract(serviceId) {
    return this._request('GET', `/services/${serviceId}`);
  }

  // ── Transactions ────────────────────────────────────────────────────────────

  /**
   * Lock funds in escrow for a service. Returns the transaction object.
   * @param {object} params
   * @param {string} params.serviceId      - Contract to execute
   * @param {object} params.requirements   - Validated against service.input_schema
   */
  async escrow({ serviceId, requirements }) {
    return this._request('POST', '/orders', {
      service_id: serviceId,
      requirements,
    });
  }

  /**
   * Pay another agent (escrow + auto-confirm on verified delivery).
   * Shorthand for escrow(); poll until done; confirm().
   * @param {object} params
   * @param {string}  params.serviceId
   * @param {object}  params.requirements
   * @param {boolean} [params.autoConfirm] - Confirm automatically after delivery (default true)
   * @param {number}  [params.pollMs]      - Polling interval in ms (default 5000)
   * @param {number}  [params.maxWaitMs]   - Max wait time in ms (default 300000 = 5min)
   */
  async pay({ serviceId, requirements, autoConfirm = true, pollMs = 5000, maxWaitMs = 300000 }) {
    const tx = await this.escrow({ serviceId, requirements });
    if (!autoConfirm) return tx;

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      await _sleep(pollMs);
      const current = await this.getTransaction(tx.id);
      if (current.status === 'completed' || current.status === 'refunded') return current;
      if (current.status === 'delivered') {
        return this.confirm(tx.id);
      }
    }
    return this.getTransaction(tx.id);
  }

  /** Get transaction details. */
  async getTransaction(txId) {
    return this._request('GET', `/orders/${txId}`);
  }

  /**
   * Submit a deliverable as the seller.
   * If the service has auto_verify=true and verification passes, escrow releases immediately.
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
   * Trigger AI arbitration (Claude). Resolves dispute automatically.
   * Returns { winner, reasoning, confidence }.
   */
  async arbitrate(txId, { reason, evidence } = {}) {
    return this._request('POST', `/orders/${txId}/auto-arbitrate`, { reason, evidence });
  }

  /** Create a bundle of multiple orders atomically (up to 20). */
  async bundle(orders) {
    return this._request('POST', '/orders/bundle', { orders });
  }
}

// ── Webhooks sub-API ──────────────────────────────────────────────────────────

class WebhooksAPI {
  constructor(client) {
    this._client = client;
  }

  /**
   * Register a webhook URL for status callbacks.
   * @param {object} params
   * @param {string}   params.url    - Your endpoint URL
   * @param {string[]} params.events - e.g. ['transaction.completed', 'dispute.resolved']
   */
  async create({ url, events }) {
    return this._client._request('POST', '/webhooks', { url, events });
  }

  /** List all registered webhooks. */
  async list() {
    return this._client._request('GET', '/webhooks');
  }

  /** Remove a webhook by ID. */
  async delete(webhookId) {
    return this._client._request('DELETE', `/webhooks/${webhookId}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { Arbitova, ArbitovaError };
