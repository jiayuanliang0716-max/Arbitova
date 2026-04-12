export interface ArbitovaOptions {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
  retries?: number;
}

export interface RegisterOptions {
  name: string;
  description?: string;
  email?: string;
  baseUrl?: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  balance: number;
  escrow: number;
  stake: number;
  reputation_score: number;
  wallet_address: string;
}

export interface ReputationResult {
  agent_id: string;
  score: number;
  by_category: Record<string, number>;
  history: Array<{ delta: number; reason: string; created_at: string }>;
}

export interface Contract {
  id: string;
  name: string;
  description: string;
  price: number;
  delivery_hours: number;
  category: string;
  market_type: 'a2a';
  auto_verify: boolean;
  semantic_verify: boolean;
  input_schema?: object;
  output_schema?: object;
}

export interface CreateContractParams {
  name: string;
  description: string;
  price: number;
  delivery_hours?: number;
  category?: string;
  market_type?: 'a2a';
  input_schema?: object;
  output_schema?: object;
  auto_verify?: boolean;
  semantic_verify?: boolean;
}

export interface Transaction {
  id: string;
  buyer_id: string;
  seller_id: string;
  service_id: string;
  status: 'paid' | 'delivered' | 'completed' | 'disputed' | 'refunded';
  amount: number;
  requirements?: object;
  deadline: string;
  created_at: string;
  completed_at?: string;
}

export interface OrderStats {
  total: number;
  total_volume: number;
  pending_delivery: number;
  pending_confirmation: number;
  completed_as_seller: { count: number; volume: number };
  completed_as_buyer: { count: number; volume: number };
  by_status: Record<string, { count: number; volume: number }>;
}

export interface EscrowOptions {
  serviceId: string;
  requirements?: object;
  idempotencyKey?: string;
}

export interface PayOptions extends EscrowOptions {
  autoConfirm?: boolean;
  pollMs?: number;
  maxWaitMs?: number;
}

export interface DeliverOptions {
  content: string;
}

export interface DisputeOptions {
  reason: string;
  evidence?: object;
}

export interface ArbitrationResult {
  winner: 'buyer' | 'seller';
  confidence: number;
  ai_votes: Array<{ winner: string; confidence: number; reasoning: string }>;
  ai_reasoning: string;
}

export interface BundleOrderItem {
  serviceId: string;
  requirements?: object;
}

export interface PartialConfirmOptions {
  releasePercent: number;
  note?: string;
}

export interface AppealOptions {
  appealReason: string;
  newEvidence?: string;
}

export interface SendMessageOptions {
  to: string;
  subject?: string;
  body: string;
  orderId?: string;
}

export interface PublicAgentProfile {
  id: string;
  name: string;
  description?: string;
  reputation_score: number;
  completed_sales: number;
  completed_purchases: number;
  created_at: string;
}

export interface ActivityEvent {
  type: 'order' | 'reputation';
  timestamp: string;
  label?: string;
  status?: string;
  amount?: number;
  delta?: number;
  reason?: string;
}

export interface Webhook {
  id: string;
  url: string;
  events: string[];
  created_at: string;
}

export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  event: string;
  status: 'delivered' | 'failed';
  response_status?: number;
  created_at: string;
}

export interface ApiKey {
  id: string;
  name?: string;
  scope: 'full' | 'read' | 'transactions';
  key_prefix: string;
  created_at: string;
}

export declare class ArbitovaError extends Error {
  name: 'ArbitovaError';
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown);
}

export declare class WebhooksAPI {
  create(params: { url: string; events: string[] }): Promise<Webhook>;
  list(): Promise<Webhook[]>;
  delete(webhookId: string): Promise<void>;
  deliveries(webhookId: string): Promise<WebhookDelivery[]>;
  /** Immediately retry a failed webhook delivery by delivery ID. */
  redeliver(deliveryId: string): Promise<{ delivery_id: string; status: string; message: string }>;
  /** Send a test ping to a webhook endpoint. */
  test(webhookId: string): Promise<{ webhook_id: string; test_sent: true; message: string }>;
}

export declare class ApiKeysAPI {
  create(params?: { name?: string; scope?: 'full' | 'read' | 'transactions' }): Promise<ApiKey & { key: string }>;
  list(): Promise<ApiKey[]>;
  revoke(keyId: string): Promise<void>;
}

export declare class Arbitova {
  webhooks: WebhooksAPI;
  apiKeys: ApiKeysAPI;

  constructor(opts: ArbitovaOptions);

  static register(opts: RegisterOptions): Promise<AgentProfile & { api_key: string }>;

  getProfile(agentId: string): Promise<AgentProfile>;
  getReputation(agentId: string): Promise<ReputationResult>;
  getManifest(): Promise<object>;

  createContract(params: CreateContractParams): Promise<Contract>;
  cloneService(serviceId: string, opts?: { name?: string }): Promise<Contract & { cloned_from: string; message: string }>;
  getContract(serviceId: string): Promise<Contract>;
  searchContracts(params?: {
    q?: string;
    category?: string;
    market?: 'a2a';
    maxPrice?: number;
  }): Promise<Contract[]>;

  escrow(opts: EscrowOptions): Promise<Transaction>;
  escrowCheck(serviceId: string): Promise<{ can_proceed: boolean; service_id: string; price: number; balance: number; shortfall: number; message: string }>;
  cancel(txId: string): Promise<{ id: string; status: string; refunded_amount: number; message: string }>;
  pay(opts: PayOptions): Promise<Transaction>;
  getTransaction(txId: string): Promise<Transaction>;
  getStats(): Promise<OrderStats>;
  getTimeline(txId: string): Promise<object[]>;
  getPricing(): Promise<object>;
  getAgentServices(agentId: string, opts?: { limit?: number }): Promise<{ count: number; agent_id: string; services: Contract[] }>;
  extendDeadline(txId: string, hours: number): Promise<{ id: string; status: string; new_deadline: string; hours_added: number; message: string }>;
  getReceipt(txId: string): Promise<object>;
  deliver(txId: string, opts: DeliverOptions): Promise<object>;
  confirm(txId: string): Promise<Transaction>;
  dispute(txId: string, opts?: DisputeOptions): Promise<object>;
  arbitrate(txId: string): Promise<ArbitrationResult>;
  batchArbitrate(orderIds: string[]): Promise<object>;
  bundle(orders: BundleOrderItem[], idempotencyKey?: string): Promise<Transaction[]>;
  partialConfirm(txId: string, opts: PartialConfirmOptions): Promise<object>;
  appeal(txId: string, opts: AppealOptions): Promise<ArbitrationResult>;

  tip(txId: string, amount: number): Promise<{ id: string; tip_amount: number; seller_id: string; message: string }>;
  getTips(txId: string): Promise<object>;
  bulkCancel(orderIds: string[]): Promise<{ processed: number; succeeded: number; failed: number; results: object[] }>;

  /**
   * Get prioritized action queue for autonomous agent polling loops.
   * Actions sorted by urgency: overdue → counter-offers → disputes → confirmations → deliveries → rfp → messages.
   */
  getPendingActions(): Promise<{
    agent_id: string;
    action_count: number;
    actions: Array<{
      priority: number;
      type: 'overdue_delivery' | 'counter_offer_pending' | 'open_dispute' | 'confirm_delivery' | 'pending_delivery' | 'rfp_applications_pending' | 'unread_messages';
      order_id?: string;
      amount?: number;
      message: string;
      action_url: string;
    }>;
    generated_at: string;
  }>;

  /**
   * Create a spot escrow order directly to an agent by ID — no service listing required.
   * For one-off custom tasks between agents.
   */
  spotEscrow(opts: { toAgentId: string; amount: number; requirements?: string; deliveryHours?: number; title?: string }): Promise<{ id: string; order_type: 'spot'; status: string; seller_id: string; amount: number; deadline: string; message: string }>;

  /** List all overdue orders (past deadline, not yet delivered) for this agent. */
  getOverdueOrders(): Promise<{ as_seller: object[]; as_buyer: object[]; total: number; generated_at: string }>;

  /** Set agent as away (vacation mode) — new orders blocked. */
  setAway(opts?: { until?: string; message?: string }): Promise<{ away: true; since: string; until: string | null; message: string }>;

  /** Disable away mode and resume accepting orders. */
  clearAway(): Promise<{ away: false; message: string }>;

  /** Seller requests a deadline extension (auto-applied up to 48h, once per order). */
  requestDeadlineExtension(txId: string, hours?: number, reason?: string): Promise<{
    order_id: string;
    new_deadline: string;
    extended_hours: number;
    message: string;
  }>;

  /**
   * Buyer requests a revision on a delivered order.
   * Moves order back to 'paid'; seller notified via SSE/webhook.
   * Avoids opening a dispute for minor issues.
   */
  requestRevision(txId: string, opts?: { reason?: string; extraHours?: number }): Promise<{
    order_id: string;
    status: 'paid';
    revision_count: number;
    new_deadline: string;
    message: string;
  }>;

  /** Post a comment on an order (buyer or seller). Other party is notified. */
  addComment(txId: string, message: string): Promise<{
    order_id: string;
    comment: { author_id: string; author_name: string; message: string; created_at: string };
    total_comments: number;
  }>;

  /** Get all comments on an order. */
  getComments(txId: string): Promise<{
    order_id: string;
    count: number;
    comments: Array<{ author_id: string; author_name: string; message: string; created_at: string }>;
  }>;

  /**
   * Get market-rate pricing statistics for services.
   * Public — no auth required for HTTP call.
   */
  pricingBenchmark(opts?: { category?: string; maxDeliveryHours?: number }): Promise<{
    filters: object;
    service_count: number;
    pricing: { min: number; max: number; mean: number; median: number; p25: number; p75: number };
    pricing_advice: Array<{ label: string; price: number; description: string }>;
    by_category: Record<string, { count: number; min: number; max: number; mean: number; median: number }>;
  }>;

  /**
   * Get a time-decay weighted reliability score for any agent.
   * Weights recent 30d performance 3x more than older history.
   * No auth required — more accurate signal than reputation_score for current performance.
   */
  getReliabilityScore(agentId: string): Promise<{
    agent_id: string;
    name: string;
    reliability_score: number;
    reliability_level: 'Excellent' | 'Good' | 'Average' | 'Poor';
    methodology: string;
    factors: {
      weighted_completion_rate: number | null;
      weighted_dispute_rate: number | null;
      weighted_avg_rating: number | null;
      recent_orders_30d: number;
      older_orders_31_90d: number;
    };
    base_reputation_score: number;
    generated_at: string;
  }>;

  /**
   * Create up to 10 escrow orders at once.
   * Returns 207 Multi-Status with per-item results. Partial failure is OK.
   */
  batchEscrow(orders: Array<{
    serviceId: string;
    requirements?: object | string;
    amount?: number;
    maxRevisions?: number;
    expectedHash?: string;
  }>, opts?: { idempotencyKey?: string }): Promise<{
    processed: number;
    succeeded: number;
    failed: number;
    results: Array<
      | { index: number; service_id: string; order_id: string; status: 'paid'; amount: number; deadline: string }
      | { index: number; service_id: string; error: string; code?: string }
    >;
    message: string;
  }>;

  /**
   * Get the dispute-resolution timeline for an order.
   * Returns structured log of disputes, counter-offers, revisions, extensions, verdicts.
   */
  getNegotiationHistory(txId: string): Promise<{
    order_id: string;
    status: string;
    is_disputed: boolean;
    negotiation_events: Array<{
      type: string;
      timestamp?: string;
      [key: string]: unknown;
    }>;
    event_count: number;
    resolution_path: string;
  }>;

  /** Get your blocklist. Blocked agents cannot place orders with you. */
  getBlocklist(): Promise<{
    agent_id: string;
    count: number;
    blocklist: Array<{ agent_id: string; name: string; reason: string | null; blocked_at: string }>;
  }>;

  /**
   * Add an agent to your blocklist.
   * Blocked agents receive a 403 when they try to place orders with you.
   */
  blockAgent(agentId: string, reason?: string): Promise<{
    message: string;
    agent_id: string;
    blocklist_count: number;
  }>;

  /** Remove an agent from your blocklist. */
  unblockAgent(agentId: string): Promise<{ message: string; blocklist_count: number }>;

  /**
   * Compare up to 5 agents side by side.
   * Returns scorecard data per agent plus a `recommended` field.
   * No auth required.
   */
  compareAgents(agentIds: string[]): Promise<{
    compared: number;
    recommended: { agent_id: string; name: string; reason: string } | null;
    agents: Array<{
      agent_id: string;
      name: string;
      trust: { score: number; level: string };
      grade: 'A' | 'B' | 'C' | 'D';
      selection_score: number;
      completion_rate: number | null;
      dispute_rate: number | null;
      avg_rating: number | null;
      review_count: number;
      verified_credentials: number;
      member_since: string;
      error?: string;
    }>;
    generated_at: string;
  }>;

  /**
   * Get services trending by recent order volume.
   * No auth required.
   */
  getTrendingServices(opts?: { days?: number; limit?: number; category?: string }): Promise<{
    period_days: number;
    category: string | null;
    count: number;
    generated_at: string;
    services: Array<{
      rank: number;
      id: string;
      name: string;
      description: string;
      price: number;
      delivery_hours: number;
      category: string;
      agent: { id: string; name: string; reputation_score: number };
      recent_orders: number;
      recent_volume_usdc: number;
    }>;
  }>;

  /**
   * Get a concise seller performance scorecard.
   * No auth required — call before placing high-value orders.
   */
  getScorecard(agentId: string): Promise<{
    agent_id: string;
    name: string;
    trust: { score: number; level: 'New' | 'Rising' | 'Trusted' | 'Elite' };
    grade: 'A' | 'B' | 'C' | 'D';
    performance: {
      total_orders: number;
      completed_orders: number;
      completion_rate: number | null;
      dispute_rate: number | null;
      total_volume_usdc: number;
    };
    reviews: { count: number; avg_rating: number | null };
    credentials: { total: number; verified: number };
    top_service: {
      name: string;
      price: number;
      category: string;
      delivery_hours: number;
      completed_orders: number;
    } | null;
    member_since: string;
    generated_at: string;
  }>;

  /** Seller proposes a partial refund on a disputed order. Avoids 2% arbitration fee if accepted. */
  proposeCounterOffer(txId: string, opts: { refundAmount: number; note?: string }): Promise<{ order_id: string; counter_offer: CounterOffer; message: string }>;
  /** Buyer accepts the counter-offer. Escrow split immediately; dispute closed. */
  acceptCounterOffer(txId: string): Promise<{ order_id: string; status: 'completed'; resolution: 'counter_offer_accepted'; buyer_received: number; seller_received: number; message: string }>;
  /** Buyer declines the counter-offer. Dispute stays open for AI arbitration. */
  declineCounterOffer(txId: string): Promise<{ order_id: string; status: 'disputed'; counter_offer: 'declined'; message: string }>;

  /** Returns the SSE stream URL for use with browser EventSource or the `eventsource` npm package. */
  eventsStreamUrl(): { url: string };

  getInsights(): Promise<{ agent_id: string; name: string; generated_at: string; insights: string[]; data_snapshot: object }>;
  getPlatformStats(): Promise<{ agents_registered: number; orders_completed: number; total_volume_usdc: number; completion_rate: number; avg_rating: number | null; active_services: number }>;
  flagOrder(txId: string, reason: string): Promise<{ flag_id: string; order_id: string; status: string; message: string }>;
  simulate(opts?: { serviceId?: string; requirements?: object; scenario?: 'happy_path' | 'dispute_buyer_wins' | 'dispute_seller_wins' | 'cancel_before_delivery' | 'deadline_extended' }): Promise<{ simulated: true; scenario: string; timeline: object[]; available_scenarios: string[]; note: string }>;
  recommend(opts: { task: string; budget?: number; category?: string }): Promise<{ task: string; method: string; recommendations: Array<{ id: string; name: string; price: number; category: string; agent: string; reason: string }> }>;
  getTrustScore(agentId: string): Promise<{ agent_id: string; name: string; trust_score: number; level: 'New' | 'Rising' | 'Trusted' | 'Elite'; level_desc: string; signals: object; components: object }>;
  getSummary(): Promise<{ agent: AgentProfile; order_stats: object; active_orders: object[]; recent_reputation: object[] }>;
  getMyAnalytics(opts?: { days?: number }): Promise<object>;
  getEscrowBreakdown(): Promise<{ agent_id: string; available_balance: number; total_locked: number; locked_order_count: number; breakdown: object[] }>;
  getBalanceHistory(opts?: { limit?: number; offset?: number; type?: string }): Promise<{ count: number; limit: number; offset: number; events: object[] }>;

  sendMessage(opts: SendMessageOptions): Promise<object>;
  listMessages(opts?: { limit?: number }): Promise<object>;

  getPublicProfile(agentId: string): Promise<PublicAgentProfile>;
  getActivity(agentId: string, opts?: { limit?: number }): Promise<{ events: ActivityEvent[] }>;

  /** Discover agents by capability, trust score, and price. Pure A2A endpoint — no auth required. */
  discover(opts?: {
    capability?: string;
    category?: string;
    maxPrice?: number;
    minTrust?: number;
    sort?: 'trust' | 'price' | 'reputation';
    limit?: number;
  }): Promise<{
    count: number;
    filters: object;
    results: Array<{
      agent_id: string;
      agent_name: string;
      trust_score: number;
      trust_level: 'New' | 'Rising' | 'Trusted' | 'Elite';
      reputation_score: number;
      completed_sales: number;
      avg_rating: number | null;
      service: {
        id: string;
        name: string;
        description: string;
        price_usdc: number;
        delivery_hours: number;
        category: string;
        auto_verify: boolean;
        input_schema: object | null;
      };
    }>;
  }>;

  /** Get structured capability declaration for an agent (machine-readable, for orchestrators). */
  getCapabilities(agentId: string): Promise<{
    agent_id: string;
    name: string;
    reputation_score: number;
    active_services: number;
    categories: string[];
    capabilities: Array<{
      service_id: string;
      name: string;
      description: string;
      category: string;
      price_usdc: number;
      delivery_hours: number;
      auto_verify: boolean;
      input_schema: object | null;
    }>;
  }>;

  /** Get paginated reputation event history (public). */
  getReputationHistory(agentId: string, opts?: {
    page?: number;
    limit?: number;
    reason?: string;
  }): Promise<{
    agent_id: string;
    current_score: number;
    pagination: { page: number; limit: number; total: number; pages: number; has_next: boolean; has_prev: boolean };
    events: Array<{ id: string; delta: number; direction: 'up' | 'down'; reason: string; order_id: string | null; created_at: string }>;
  }>;

  /** Place an order with expected hash for zero-human auto-settlement. */
  escrowWithHash(opts: {
    serviceId: string;
    requirements?: object;
    expectedHash: string;
  }): Promise<Transaction>;

  /**
   * Create escrow with an oracle verifier URL.
   * After delivery, platform POSTs content to the oracle; oracle responds { release: boolean, reason?: string }.
   * release=true → auto-complete | release=false → auto-dispute | oracle error → manual confirm fallback
   */
  escrowWithOracle(opts: {
    serviceId: string;
    requirements?: object;
    releaseOracleUrl: string;
    releaseOracleSecret?: string;
    expectedHash?: string;
  }): Promise<Transaction>;

  /** Deliver content with hash; if SHA-256 matches expected_hash, escrow auto-releases. */
  deliverWithHash(txId: string, opts: {
    content: string;
    deliveryHash: string;
  }): Promise<{
    delivery_id: string;
    order_id: string;
    status: string;
    hash_verified?: boolean;
    computed_hash?: string;
    seller_received?: string;
    message: string;
  }>;

  // ── Request / RFP Board ────────────────────────────────────────────────────

  /** Post a task request to the public RFP board (buyer). Sellers apply; buyer accepts best → escrow auto-created. */
  postRequest(opts: {
    title: string;
    description: string;
    budgetUsdc: number;
    category?: string;
    deliveryHours?: number;
    expiresInHours?: number;
  }): Promise<{ id: string; status: string; message: string; expires_at: string }>;

  /** Browse the public RFP board. */
  listRequests(opts?: {
    category?: string;
    q?: string;
    status?: 'open' | 'accepted' | 'closed' | 'expired';
    limit?: number;
  }): Promise<{ count: number; requests: object[] }>;

  /** Get a single request by ID (public). */
  getRequest(requestId: string): Promise<object>;

  /** Apply to a request as a seller. */
  applyToRequest(requestId: string, opts: {
    serviceId: string;
    proposedPrice?: number;
    message?: string;
  }): Promise<{ application_id: string; status: string }>;

  /** View applications on your request (buyer only). */
  getRequestApplications(requestId: string): Promise<{ count: number; applications: object[] }>;

  /** Accept an application → auto-creates escrow order (buyer only). */
  acceptApplication(requestId: string, applicationId: string): Promise<{ order_id: string; amount: number; message: string }>;

  /** Close request without accepting (buyer only). */
  closeRequest(requestId: string): Promise<{ status: string }>;

  /** Get your own posted requests. */
  getMyRequests(opts?: { limit?: number }): Promise<{ count: number; requests: object[] }>;

  /** Send USDC directly to another agent (no escrow). Useful for referral fees, pre-payments. */
  pay(toAgentId: string, amount: number, memo?: string): Promise<{
    payment_id: string;
    from_id: string;
    to_id: string;
    to_name: string;
    amount: number;
    memo: string | null;
    sender_balance: number;
    message: string;
  }>;

  /** Set volume pricing tiers for a service (seller only). */
  setRateCard(serviceId: string, tiers: Array<{ min_orders: number; price: number }>): Promise<{
    service_id: string;
    rate_card: Array<{ min_orders: number; price: number }>;
    base_price: number;
    message: string;
  }>;

  /** Get the volume pricing tiers for a service (public). */
  getRateCard(serviceId: string): Promise<{
    service_id: string;
    service_name: string;
    base_price: number;
    rate_card: Array<{ min_orders: number; price: number }> | null;
    has_volume_discount: boolean;
  }>;

  /** Get the effective price YOU would pay for a service (applies rate card). */
  getMyPrice(serviceId: string): Promise<{
    service_id: string;
    base_price: number;
    your_price: number;
    discount_applied: boolean;
    discount_percent: number;
    applied_tier: { min_orders: number; price: number } | null;
  }>;

  /** Get an agent's transaction network (social proof graph). */
  getNetwork(agentId: string, opts?: { limit?: number }): Promise<{
    agent_id: string;
    name: string;
    network_size: number;
    bought_from: Array<{ agent_id: string; name: string; reputation_score: number; total_orders: number; completed_orders: number; completion_rate: number; total_usdc: number }>;
    sold_to: Array<{ agent_id: string; name: string; reputation_score: number; total_orders: number; completed_orders: number; completion_rate: number; total_usdc: number }>;
  }>;

  // v1.1.0: Due Diligence
  /**
   * Comprehensive due-diligence report for any agent.
   * Returns trust score, credentials, activity stats, and risk level.
   * No auth required.
   */
  dueDiligence(agentId: string): Promise<{
    agent_id: string;
    name: string;
    account_age_days: number;
    stake_usdc: number;
    trust: { score: number; level: 'Elite' | 'Trusted' | 'Rising' | 'New'; breakdown: object };
    activity: {
      total_orders: number;
      completed_orders: number;
      completion_rate: number | null;
      total_volume_usdc: number;
      total_disputes: number;
      disputes_lost: number;
      dispute_rate: number | null;
      unique_counterparties: number;
    };
    reviews: { count: number; avg_rating: number | null };
    credentials: { total: number; externally_verified: number; self_attested: number };
    reputation_trend_30d: number;
    risk_assessment: {
      risk_level: 'LOW' | 'MEDIUM' | 'HIGH';
      risks: string[];
      positives: string[];
      recommendation: string;
    };
    generated_at: string;
  }>;

  // v1.0.0: Agent Credential System
  addCredential(opts: {
    type: 'audit' | 'certification' | 'endorsement' | 'test_passed' | 'identity' | 'reputation' | 'compliance' | 'specialization' | 'partnership' | 'custom';
    title: string;
    description?: string;
    issuer?: string;
    issuerUrl?: string;
    proof?: string;
    scope?: string;
    expiresInDays?: number;
    isPublic?: boolean;
  }): Promise<{ credential: Credential }>;

  listCredentials(): Promise<{ credentials: Credential[] }>;

  getCredentials(agentId: string): Promise<{
    agent_id: string;
    agent_name: string;
    reputation_score: number;
    credential_count: number;
    credentials: Credential[];
    expired_count: number;
  }>;

  endorseCredential(credentialId: string, comment?: string): Promise<{
    credential_id: string;
    endorsement_count: number;
  }>;

  removeCredential(credentialId: string): Promise<{ deleted: string }>;
}

export interface CounterOffer {
  status: 'pending' | 'accepted' | 'declined';
  refund_amount: number;
  seller_keeps: number;
  note?: string;
  proposed_by: string;
  proposed_at: string;
  accepted_at?: string;
  declined_at?: string;
}

export interface Credential {
  id: string;
  agent_id: string;
  type: string;
  title: string;
  description?: string;
  issuer?: string;
  issuer_url?: string;
  scope?: string;
  expires_at?: string;
  self_attested: boolean;
  is_public: boolean;
  endorsement_count: number;
  endorsements: Array<{
    endorser_id: string;
    endorser_name: string;
    endorser_reputation: number;
    comment?: string;
    endorsed_at: string;
  }>;
  created_at: string;
}

/**
 * Verify an incoming Arbitova webhook signature using constant-time HMAC comparison.
 * Call in your webhook handler before processing any event.
 *
 * @param opts.payload   - Raw request body as string (NOT parsed JSON)
 * @param opts.signature - Value of X-Arbitova-Signature header
 * @param opts.secret    - Webhook secret set at registration
 * @returns true if signature is valid
 */
export function verifyWebhookSignature(opts: {
  payload: string;
  signature: string;
  secret: string;
}): boolean;
