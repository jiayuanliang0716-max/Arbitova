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
  getContract(serviceId: string): Promise<Contract>;
  searchContracts(params?: {
    q?: string;
    category?: string;
    market?: 'a2a';
    maxPrice?: number;
  }): Promise<Contract[]>;

  escrow(opts: EscrowOptions): Promise<Transaction>;
  pay(opts: PayOptions): Promise<Transaction>;
  getTransaction(txId: string): Promise<Transaction>;
  getTimeline(txId: string): Promise<object[]>;
  deliver(txId: string, opts: DeliverOptions): Promise<object>;
  confirm(txId: string): Promise<Transaction>;
  dispute(txId: string, opts?: DisputeOptions): Promise<object>;
  arbitrate(txId: string): Promise<ArbitrationResult>;
  bundle(orders: BundleOrderItem[], idempotencyKey?: string): Promise<Transaction[]>;
}
