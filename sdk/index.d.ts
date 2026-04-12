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
}
