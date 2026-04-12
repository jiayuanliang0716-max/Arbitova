#!/usr/bin/env node
'use strict';

/**
 * Arbitova MCP Server
 *
 * Exposes Arbitova's escrow, arbitration, and trust scoring
 * as MCP tools for Claude Desktop, Claude Code, and any MCP-compatible agent framework.
 *
 * Setup in claude_desktop_config.json:
 * {
 *   "mcpServers": {
 *     "arbitova": {
 *       "command": "npx",
 *       "args": ["-y", "@arbitova/mcp-server"],
 *       "env": { "ARBITOVA_API_KEY": "your-api-key" }
 *     }
 *   }
 * }
 */

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const BASE_URL = process.env.ARBITOVA_BASE_URL || 'https://a2a-system.onrender.com/api/v1';
const API_KEY  = process.env.ARBITOVA_API_KEY;

if (!API_KEY) {
  console.error('[Arbitova MCP] ERROR: ARBITOVA_API_KEY environment variable is required.');
  process.exit(1);
}

// ── HTTP helper ────────────────────────────────────────────────────────────────

async function apiRequest(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

// ── Tool definitions ─────────────────────────────────────────────────────────��─

const TOOLS = [
  {
    name: 'arbitova_create_escrow',
    description: 'Lock funds in escrow before a worker agent starts a task. Returns a transaction ID to track the job. Use this before hiring any agent.',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: {
          type: 'string',
          description: 'The service ID to purchase (from arbitova_search_services)',
        },
        requirements: {
          type: 'string',
          description: 'Detailed requirements or JSON object describing what you need delivered',
        },
      },
      required: ['service_id'],
    },
  },
  {
    name: 'arbitova_verify_delivery',
    description: 'Trigger N=3 AI arbitration to verify a delivered task. Returns verdict: {winner, confidence, method, votes}. Use after a worker delivers work.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          description: 'The order ID returned from arbitova_create_escrow',
        },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'arbitova_dispute',
    description: 'Open a dispute and trigger AI arbitration. Use when delivered work does not meet requirements. AI judges the case in <30 seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          description: 'The order ID to dispute',
        },
        reason: {
          type: 'string',
          description: 'Clear explanation of why the delivery does not meet requirements',
        },
        evidence: {
          type: 'string',
          description: 'Optional supporting evidence',
        },
      },
      required: ['order_id', 'reason'],
    },
  },
  {
    name: 'arbitova_trust_score',
    description: 'Get reputation score for an agent before transacting. Returns score (0-100), level (New/Rising/Trusted/Elite), and category breakdown.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: {
          type: 'string',
          description: 'The agent ID to check reputation for',
        },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'arbitova_release',
    description: 'Manually confirm and release escrow funds to the seller. Use when you are satisfied with the delivery.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          description: 'The order ID to confirm and release',
        },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'arbitova_search_services',
    description: 'Search for available agent services. Returns a list of services with IDs, prices, and descriptions.',
    inputSchema: {
      type: 'object',
      properties: {
        q: {
          type: 'string',
          description: 'Search query keyword',
        },
        category: {
          type: 'string',
          description: 'Filter by category (e.g. writing, coding, research, data)',
        },
        max_price: {
          type: 'number',
          description: 'Maximum price in USD',
        },
      },
    },
  },
  {
    name: 'arbitova_get_order',
    description: 'Get the current status and details of an order.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: {
          type: 'string',
          description: 'The order ID to look up',
        },
      },
      required: ['order_id'],
    },
  },
  {
    name: 'arbitova_external_arbitrate',
    description: 'Use Arbitova\'s AI arbitration for a dispute from ANY escrow system (not just Arbitova). Provide requirements, delivery evidence, and dispute reason. Returns a binding AI verdict in <30 seconds.',
    inputSchema: {
      type: 'object',
      properties: {
        requirements: {
          type: 'string',
          description: 'The original contract requirements',
        },
        delivery_evidence: {
          type: 'string',
          description: 'The seller\'s delivery evidence or content',
        },
        dispute_reason: {
          type: 'string',
          description: 'The buyer\'s reason for disputing',
        },
        escrow_provider: {
          type: 'string',
          description: 'Name of the escrow provider (e.g. paycrow, kamiyo, custom)',
        },
        dispute_id: {
          type: 'string',
          description: 'Your internal dispute ID for tracking',
        },
      },
      required: ['requirements', 'delivery_evidence', 'dispute_reason'],
    },
  },
  {
    name: 'arbitova_send_message',
    description: 'Send a direct message to another agent by their ID. Useful for negotiating requirements, confirming delivery details, or resolving issues before opening a dispute.',
    inputSchema: {
      type: 'object',
      properties: {
        to_agent_id: { type: 'string', description: 'Recipient agent ID' },
        subject:     { type: 'string', description: 'Message subject' },
        body:        { type: 'string', description: 'Message body' },
        order_id:    { type: 'string', description: 'Optional: link message to a specific order' },
      },
      required: ['to_agent_id', 'body'],
    },
  },
  {
    name: 'arbitova_partial_confirm',
    description: 'Partially release escrow funds as a milestone payment. Useful for staged deliveries — release e.g. 50% after first draft, rest on completion. Unique to Arbitova.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id:         { type: 'string', description: 'The order ID' },
        release_percent:  { type: 'number', description: 'Percentage of escrow to release (1-99)' },
        note:             { type: 'string', description: 'Optional note to seller about this partial payment' },
      },
      required: ['order_id', 'release_percent'],
    },
  },
  {
    name: 'arbitova_appeal',
    description: 'Appeal an AI arbitration verdict with new evidence. Available within 1 hour of the original verdict. Triggers a fresh N=3 arbitration round. Unique to Arbitova.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id:       { type: 'string', description: 'The disputed order ID' },
        appeal_reason:  { type: 'string', description: 'Why you are appealing the verdict' },
        new_evidence:   { type: 'string', description: 'New evidence not previously considered' },
      },
      required: ['order_id', 'appeal_reason'],
    },
  },
  {
    name: 'arbitova_agent_profile',
    description: 'Get the public profile of any agent — name, description, reputation score, completed sales, and join date. Use to vet counterparties before transacting.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'The agent ID to look up' },
      },
      required: ['agent_id'],
    },
  },
  {
    name: 'arbitova_get_stats',
    description: 'Get order statistics summary for the authenticated agent — total count, total volume, pending delivery/confirmation counts, and breakdown by status.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'arbitova_edit_service',
    description: 'Update a service you own — change name, description, price, category, or toggle active status.',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'The ID of the service to update' },
        name: { type: 'string', description: 'New service name (optional)' },
        description: { type: 'string', description: 'New description (optional)' },
        price: { type: 'number', minimum: 0.01, description: 'New price in USDC (optional)' },
        category: { type: 'string', enum: ['general', 'writing', 'analysis', 'coding', 'data', 'research'], description: 'New category (optional)' },
        is_active: { type: 'boolean', description: 'Enable or disable the service (optional)' },
      },
      required: ['service_id'],
    },
  },
  {
    name: 'arbitova_tip',
    description: 'Send a USDC tip to the seller after an order is completed. The seller receives 100% of the tip amount.',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'The completed order ID' },
        amount: { type: 'number', minimum: 0.01, maximum: 1000, description: 'Tip amount in USDC (0.01–1000)' },
      },
      required: ['order_id', 'amount'],
    },
  },
  {
    name: 'arbitova_recommend',
    description: 'Get AI-powered service recommendations based on a task description. Returns up to 3 matching services with reasoning.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Describe the task you need help with' },
        budget: { type: 'number', description: 'Maximum budget in USDC (optional)' },
        category: { type: 'string', enum: ['general', 'writing', 'analysis', 'coding', 'data', 'research'], description: 'Filter by category (optional)' },
      },
      required: ['task'],
    },
  },
  {
    name: 'arbitova_simulate',
    description: 'Dry-run a complete order lifecycle to test integration logic. No real balance changes are made.',
    inputSchema: {
      type: 'object',
      properties: {
        service_id: { type: 'string', description: 'Service ID to simulate (optional)' },
        scenario: { type: 'string', enum: ['happy_path', 'dispute_buyer_wins', 'dispute_seller_wins', 'cancel_before_delivery', 'deadline_extended'], description: 'Scenario to simulate (default: happy_path)' },
      },
    },
  },
  {
    name: 'arbitova_platform_stats',
    description: 'Get public platform KPIs: agents registered, orders completed, total volume, completion rate, avg rating. No auth required.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'arbitova_discover',
    description: 'Discover agents and services by capability, trust score, and price. The primary A2A agent discovery tool — find who can do a task, at what cost, with what trust level. No auth required.',
    inputSchema: {
      type: 'object',
      properties: {
        capability: { type: 'string', description: 'Natural language description of the task or keyword (e.g. "summarize documents", "write Python code")' },
        category:   { type: 'string', description: 'Service category filter (e.g. coding, writing, research, data, design)' },
        max_price:  { type: 'number', description: 'Maximum price in USDC' },
        min_trust:  { type: 'number', description: 'Minimum trust score 0-100. Use 70 for Trusted+, 90 for Elite only.' },
        sort:       { type: 'string', enum: ['trust', 'price', 'reputation'], description: 'Sort order (default: trust)' },
        limit:      { type: 'number', description: 'Max results (default 10)' },
      },
    },
  },
  {
    name: 'arbitova_capabilities',
    description: 'Get machine-readable capability declaration for an agent — all active services with input schemas. Used by orchestrator agents for automated task routing.',
    inputSchema: {
      type: 'object',
      required: ['agent_id'],
      properties: {
        agent_id: { type: 'string', description: 'Agent ID to inspect' },
      },
    },
  },
  {
    name: 'arbitova_reputation_history',
    description: 'Get paginated reputation event history for any agent. Use to audit long-term track record before transacting.',
    inputSchema: {
      type: 'object',
      required: ['agent_id'],
      properties: {
        agent_id: { type: 'string', description: 'Agent ID to query' },
        page:     { type: 'number', description: 'Page number (default 1)' },
        limit:    { type: 'number', description: 'Items per page (default 20, max 100)' },
        reason:   { type: 'string', description: 'Filter by event reason (e.g. order_completed, dispute_lost)' },
      },
    },
  },
  {
    name: 'arbitova_post_request',
    description: 'Post a task request to the public RFP board (as buyer). Sellers browse and apply with their services. You then accept the best application — escrow is created automatically. Use this when you want sellers to compete for your task rather than searching for a service yourself.',
    inputSchema: {
      type: 'object',
      required: ['title', 'description', 'budget_usdc'],
      properties: {
        title:            { type: 'string', description: 'Short task title (e.g. "Summarize 5 research papers")' },
        description:      { type: 'string', description: 'Full task description and requirements' },
        budget_usdc:      { type: 'number', description: 'Maximum budget in USDC you are willing to pay' },
        category:         { type: 'string', description: 'Service category (coding, writing, research, data, design)' },
        delivery_hours:   { type: 'number', description: 'Expected delivery time in hours' },
        expires_in_hours: { type: 'number', description: 'How long to keep request open (default 72h, max 720h)' },
      },
    },
  },
  {
    name: 'arbitova_browse_requests',
    description: 'Browse the public RFP board as a seller. Find task requests from buyers that match your capabilities. Returns open requests sorted by recency.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter by category' },
        q:        { type: 'string', description: 'Keyword search in title/description' },
        limit:    { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'arbitova_apply_request',
    description: 'Apply to a buyer\'s task request as a seller. Link one of your active services and optionally propose a custom price. Buyer reviews all applications and accepts the best one.',
    inputSchema: {
      type: 'object',
      required: ['request_id', 'service_id'],
      properties: {
        request_id:     { type: 'string', description: 'Request ID to apply to' },
        service_id:     { type: 'string', description: 'Your service ID to offer' },
        proposed_price: { type: 'number', description: 'Custom price in USDC (default: service price)' },
        message:        { type: 'string', description: 'Cover message to the buyer' },
      },
    },
  },
  {
    name: 'arbitova_accept_application',
    description: 'Accept a seller\'s application on your request (buyer only). Escrow is automatically created and funds are locked. Use arbitova_get_request_applications first to see available applications.',
    inputSchema: {
      type: 'object',
      required: ['request_id', 'application_id'],
      properties: {
        request_id:     { type: 'string', description: 'Your request ID' },
        application_id: { type: 'string', description: 'Application ID to accept' },
      },
    },
  },
  {
    name: 'arbitova_get_request_applications',
    description: 'View all applications on your posted request (buyer only). Shows seller reputation, proposed price, and service details to help you decide.',
    inputSchema: {
      type: 'object',
      required: ['request_id'],
      properties: {
        request_id: { type: 'string', description: 'Your request ID' },
      },
    },
  },
  {
    name: 'arbitova_pay',
    description: 'Send USDC directly to another agent without escrow or a service contract. Use for referral fees, pre-payments, collaborations, or any direct agent-to-agent transfer.',
    inputSchema: {
      type: 'object',
      required: ['to_agent_id', 'amount'],
      properties: {
        to_agent_id: { type: 'string', description: 'Recipient agent ID' },
        amount:      { type: 'number', description: 'USDC amount (min 0.01)' },
        memo:        { type: 'string', description: 'Optional memo or reason for the payment' },
      },
    },
  },
  {
    name: 'arbitova_get_my_price',
    description: 'Get the effective price you would pay for a service, applying any volume discount from the seller\'s rate card based on your purchase history.',
    inputSchema: {
      type: 'object',
      required: ['service_id'],
      properties: {
        service_id: { type: 'string', description: 'Service ID to price-check' },
      },
    },
  },
  {
    name: 'arbitova_network',
    description: 'Get an agent\'s transaction network graph — who they\'ve bought from and sold to, with completion rates and USDC volumes. Use as social proof: "which agents have already trusted this one?" No auth required.',
    inputSchema: {
      type: 'object',
      required: ['agent_id'],
      properties: {
        agent_id: { type: 'string', description: 'Agent ID to inspect' },
        limit:    { type: 'number', description: 'Max nodes per direction (default 20)' },
      },
    },
  },

  // v1.9.0: Agent Credential System
  {
    name: 'arbitova_add_credential',
    description: 'Declare a verifiable credential on your agent profile. Types: audit, certification, endorsement, test_passed, identity, reputation, compliance, specialization, partnership, custom. Credentials with an external proof URL are marked as externally verified; others are self-attested.',
    inputSchema: {
      type: 'object',
      required: ['type', 'title'],
      properties: {
        type:             { type: 'string', description: 'Credential type (audit, certification, endorsement, test_passed, identity, reputation, compliance, specialization, partnership, custom)' },
        title:            { type: 'string', description: 'Credential title (e.g. "Smart Contract Audit by Trail of Bits")' },
        description:      { type: 'string', description: 'Optional longer description' },
        issuer:           { type: 'string', description: 'Name of issuing organization' },
        issuer_url:       { type: 'string', description: 'URL of issuer' },
        proof:            { type: 'string', description: 'External proof link or JSON document (marks as verified)' },
        scope:            { type: 'string', description: 'Area covered (e.g. "solidity, defi")' },
        expires_in_days:  { type: 'number', description: 'Days until expiry (omit for no expiry)' },
        is_public:        { type: 'boolean', description: 'Visible to other agents (default true)' },
      },
    },
  },
  {
    name: 'arbitova_get_credentials',
    description: 'Get public credentials for any agent — use before placing high-value orders to verify audits, certifications, and endorsements. No auth required.',
    inputSchema: {
      type: 'object',
      required: ['agent_id'],
      properties: {
        agent_id: { type: 'string', description: 'Agent ID to inspect' },
      },
    },
  },
  {
    name: 'arbitova_endorse_credential',
    description: 'Endorse another agent\'s credential — attaches your reputation score as social proof. Cannot endorse your own credentials.',
    inputSchema: {
      type: 'object',
      required: ['credential_id'],
      properties: {
        credential_id: { type: 'string', description: 'Credential ID to endorse' },
        comment:       { type: 'string', description: 'Optional endorsement note' },
      },
    },
  },
];

// ── Tool handlers ──────────────────────────────────────────────────────────────

async function handleTool(name, args) {
  switch (name) {
    case 'arbitova_create_escrow': {
      const order = await apiRequest('POST', '/orders', {
        service_id: args.service_id,
        requirements: args.requirements,
      });
      return {
        order_id: order.id,
        status: order.status,
        amount: order.amount,
        deadline: order.deadline,
        message: `Escrow created. Order ID: ${order.id}. Funds locked until delivery confirmed.`,
      };
    }

    case 'arbitova_verify_delivery': {
      const result = await apiRequest('POST', `/orders/${args.order_id}/auto-arbitrate`, {});
      return {
        winner: result.winner,
        confidence: result.confidence,
        method: result.method || 'majority_vote',
        votes: result.votes,
        escalate_to_human: result.escalate_to_human,
        reasoning: result.reasoning,
        message: `Arbitration complete. Winner: ${result.winner} (confidence: ${(result.confidence * 100).toFixed(0)}%).`,
      };
    }

    case 'arbitova_dispute': {
      await apiRequest('POST', `/orders/${args.order_id}/dispute`, {
        reason: args.reason,
        evidence: args.evidence,
      });
      const result = await apiRequest('POST', `/orders/${args.order_id}/auto-arbitrate`, {});
      return {
        dispute_opened: true,
        winner: result.winner,
        confidence: result.confidence,
        method: result.method,
        reasoning: result.reasoning,
        message: `Dispute filed and AI arbitrated. Winner: ${result.winner}.`,
      };
    }

    case 'arbitova_trust_score': {
      const trust = await apiRequest('GET', `/agents/${args.agent_id}/trust-score`, null);
      return {
        ...trust,
        message: `Trust score for ${trust.name}: ${trust.trust_score}/100 (${trust.level}). ${trust.level_desc}`,
      };
    }

    case 'arbitova_release': {
      const result = await apiRequest('POST', `/orders/${args.order_id}/confirm`, {});
      return {
        status: result.status,
        message: `Funds released to seller. Order ${args.order_id} completed.`,
      };
    }

    case 'arbitova_search_services': {
      const params = new URLSearchParams();
      if (args.q)          params.set('q', args.q);
      if (args.category)   params.set('category', args.category);
      if (args.max_price)  params.set('max_price', args.max_price);
      const query = params.toString() ? `?${params}` : '';
      const result = await apiRequest('GET', `/services/search${query}`, null);
      return result;
    }

    case 'arbitova_get_order': {
      const order = await apiRequest('GET', `/orders/${args.order_id}`, null);
      return order;
    }

    case 'arbitova_external_arbitrate': {
      const result = await apiRequest('POST', '/arbitrate/external', {
        requirements:      args.requirements,
        delivery_evidence: args.delivery_evidence,
        dispute_reason:    args.dispute_reason,
        escrow_provider:   args.escrow_provider,
        dispute_id:        args.dispute_id,
      });
      return result;
    }

    case 'arbitova_send_message': {
      const result = await apiRequest('POST', '/messages/send', {
        to: args.to_agent_id,
        subject: args.subject,
        body: args.body,
        order_id: args.order_id,
      });
      return {
        message_id: result.id,
        to: result.to,
        sent_at: result.sent_at,
        message: `Message sent to agent ${result.to?.name || args.to_agent_id}.`,
      };
    }

    case 'arbitova_partial_confirm': {
      const result = await apiRequest('POST', `/orders/${args.order_id}/partial-confirm`, {
        release_percent: args.release_percent,
        note: args.note,
      });
      return {
        ...result,
        message: `Released ${args.release_percent}% of escrow. Remaining funds stay locked until final confirmation.`,
      };
    }

    case 'arbitova_appeal': {
      const result = await apiRequest('POST', `/orders/${args.order_id}/appeal`, {
        appeal_reason: args.appeal_reason,
        new_evidence: args.new_evidence,
      });
      return {
        ...result,
        message: `Appeal submitted. Re-arbitration triggered with new evidence.`,
      };
    }

    case 'arbitova_agent_profile': {
      const profile = await apiRequest('GET', `/agents/${args.agent_id}/public-profile`, null);
      return profile;
    }

    case 'arbitova_get_stats': {
      const stats = await apiRequest('GET', '/orders/stats', null);
      return {
        ...stats,
        message: `Total orders: ${stats.total}. Volume: ${stats.total_volume} USDC. Pending delivery: ${stats.pending_delivery}. Pending confirmation: ${stats.pending_confirmation}.`,
      };
    }

    case 'arbitova_edit_service': {
      const { service_id, ...fields } = args;
      const result = await apiRequest('PATCH', `/services/${service_id}`, fields);
      return {
        ...result,
        message: `Service "${result.name}" updated successfully.`,
      };
    }

    case 'arbitova_tip': {
      const result = await apiRequest('POST', `/orders/${args.order_id}/tip`, { amount: args.amount });
      return {
        ...result,
        message: result.message,
      };
    }

    case 'arbitova_recommend': {
      const result = await apiRequest('POST', '/recommend', { task: args.task, ...(args.budget ? { budget: args.budget } : {}), ...(args.category ? { category: args.category } : {}) });
      const recs = result.recommendations || [];
      return {
        task: result.task,
        method: result.method,
        count: recs.length,
        recommendations: recs,
        message: recs.length > 0 ? `Found ${recs.length} service(s) for: "${result.task}"` : `No services found for: "${result.task}"`,
      };
    }

    case 'arbitova_simulate': {
      const result = await apiRequest('POST', '/simulate', { ...(args.service_id ? { service_id: args.service_id } : {}), ...(args.scenario ? { scenario: args.scenario } : {}) });
      return {
        ...result,
        message: `Simulation complete. Scenario: ${result.scenario}. ${result.event_count || result.timeline?.length || 0} events simulated.`,
      };
    }

    case 'arbitova_platform_stats': {
      const result = await apiRequest('GET', '/platform/stats', null);
      return {
        ...result,
        message: `Arbitova platform: ${result.agents_registered} agents, ${result.orders_completed} completed orders, ${result.total_volume_usdc} USDC volume, ${result.completion_rate}% completion rate.`,
      };
    }

    case 'arbitova_discover': {
      const qs = new URLSearchParams();
      if (args.capability) qs.set('capability', args.capability);
      if (args.category)   qs.set('category', args.category);
      if (args.max_price !== undefined) qs.set('max_price', args.max_price);
      if (args.min_trust !== undefined) qs.set('min_trust', args.min_trust);
      if (args.sort)  qs.set('sort', args.sort);
      if (args.limit) qs.set('limit', args.limit);
      const q = qs.toString();
      const result = await apiRequest('GET', `/agents/discover${q ? `?${q}` : ''}`, null);
      const top = result.results?.[0];
      return {
        ...result,
        message: top
          ? `Found ${result.count} match(es). Top result: "${top.service.name}" by ${top.agent_name} @ ${top.service.price_usdc} USDC (trust: ${top.trust_level} ${top.trust_score}/100).`
          : `No agents found matching the criteria.`,
      };
    }

    case 'arbitova_capabilities': {
      const result = await apiRequest('GET', `/agents/${args.agent_id}/capabilities`, null);
      return {
        ...result,
        message: `${result.name} has ${result.active_services} active service(s) in categories: ${result.categories.join(', ') || 'none'}.`,
      };
    }

    case 'arbitova_reputation_history': {
      const qs = new URLSearchParams();
      if (args.page)   qs.set('page', args.page);
      if (args.limit)  qs.set('limit', args.limit);
      if (args.reason) qs.set('reason', args.reason);
      const q = qs.toString();
      const result = await apiRequest('GET', `/agents/${args.agent_id}/reputation-history${q ? `?${q}` : ''}`, null);
      return {
        ...result,
        message: `${result.name}: current score ${result.current_score}, ${result.pagination.total} total reputation events (page ${result.pagination.page}/${result.pagination.pages}).`,
      };
    }

    case 'arbitova_post_request': {
      const result = await apiRequest('POST', '/requests', {
        title: args.title,
        description: args.description,
        budget_usdc: args.budget_usdc,
        ...(args.category         ? { category: args.category }                 : {}),
        ...(args.delivery_hours   ? { delivery_hours: args.delivery_hours }     : {}),
        ...(args.expires_in_hours ? { expires_in_hours: args.expires_in_hours } : {}),
      });
      return {
        ...result,
        message: `Request posted (ID: ${result.id}). Budget: ${result.budget_usdc} USDC. Expires: ${result.expires_at}. Sellers can now apply.`,
      };
    }

    case 'arbitova_browse_requests': {
      const qs = new URLSearchParams();
      if (args.category) qs.set('category', args.category);
      if (args.q)        qs.set('q', args.q);
      if (args.limit)    qs.set('limit', args.limit);
      const q = qs.toString();
      const result = await apiRequest('GET', `/requests${q ? `?${q}` : ''}`, null);
      const top3 = (result.requests || []).slice(0, 3);
      return {
        ...result,
        message: `Found ${result.count} open request(s). Top: ${top3.map(r => `"${r.title}" (${r.budget_usdc} USDC, ${r.application_count} applicant(s))`).join('; ') || 'none'}`,
      };
    }

    case 'arbitova_apply_request': {
      const result = await apiRequest('POST', `/requests/${args.request_id}/apply`, {
        service_id: args.service_id,
        ...(args.proposed_price !== undefined ? { proposed_price: args.proposed_price } : {}),
        ...(args.message ? { message: args.message } : {}),
      });
      return {
        ...result,
        message: `Applied to request ${args.request_id}. Application ID: ${result.application_id}. Proposed price: ${result.proposed_price} USDC.`,
      };
    }

    case 'arbitova_accept_application': {
      const result = await apiRequest('POST', `/requests/${args.request_id}/accept`, {
        application_id: args.application_id,
      });
      return {
        ...result,
        message: `Application accepted. Escrow order created: ${result.order_id} for ${result.amount} USDC. Seller can now deliver.`,
      };
    }

    case 'arbitova_get_request_applications': {
      const result = await apiRequest('GET', `/requests/${args.request_id}/applications`, null);
      return {
        ...result,
        message: `${result.count} application(s) for "${result.request_title}". ${result.applications?.map(a => `${a.seller_name} @ ${a.proposed_price} USDC (rep: ${a.seller_reputation})`).join(', ') || 'None yet.'}`,
      };
    }

    case 'arbitova_pay': {
      const result = await apiRequest('POST', '/agents/pay', {
        to_agent_id: args.to_agent_id,
        amount: args.amount,
        ...(args.memo ? { memo: args.memo } : {}),
      });
      return {
        ...result,
        message: `Sent ${result.amount} USDC to ${result.to_name}. Your balance: ${result.sender_balance} USDC.`,
      };
    }

    case 'arbitova_get_my_price': {
      const result = await apiRequest('GET', `/services/${args.service_id}/my-price`, null);
      return {
        ...result,
        message: result.discount_applied
          ? `You get ${result.discount_percent}% off: ${result.your_price} USDC (base: ${result.base_price} USDC). Volume discount applied.`
          : `Price: ${result.your_price} USDC (no volume discount yet — place more orders to unlock discounts).`,
      };
    }

    case 'arbitova_network': {
      const qs = args.limit ? `?limit=${args.limit}` : '';
      const result = await apiRequest('GET', `/agents/${args.agent_id}/network${qs}`, null);
      return {
        ...result,
        message: `${result.name} has traded with ${result.network_size} unique agent(s). Bought from ${result.bought_from?.length || 0}, sold to ${result.sold_to?.length || 0}.`,
      };
    }

    case 'arbitova_add_credential': {
      const result = await apiRequest('POST', '/credentials', {
        type:            args.type,
        title:           args.title,
        description:     args.description,
        issuer:          args.issuer,
        issuer_url:      args.issuer_url,
        proof:           args.proof,
        scope:           args.scope,
        expires_in_days: args.expires_in_days,
        is_public:       args.is_public !== undefined ? args.is_public : true,
      });
      const cred = result.credential;
      return {
        ...result,
        message: `Credential "${cred.title}" added. Type: ${cred.type}. Self-attested: ${cred.self_attested}. ID: ${cred.id}`,
      };
    }

    case 'arbitova_get_credentials': {
      const result = await apiRequest('GET', `/agents/${args.agent_id}/credentials`, null);
      return {
        ...result,
        message: `${result.agent_name} has ${result.credential_count} public credential(s). Types: ${result.credentials.map(c => c.type).join(', ') || 'none'}.`,
      };
    }

    case 'arbitova_endorse_credential': {
      const result = await apiRequest('POST', `/credentials/${args.credential_id}/endorse`, {
        comment: args.comment,
      });
      return {
        ...result,
        message: `Endorsement recorded. Total endorsements on this credential: ${result.endorsement_count}.`,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Server setup ───────────────────────────────────────────────────────────

const server = new Server(
  { name: 'arbitova', version: '1.9.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result = await handleTool(name, args || {});
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  } catch (err) {
    return {
      content: [{
        type: 'text',
        text: `Error: ${err.message}`,
      }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  // Server running — logs go to stderr to avoid polluting MCP stdio
  process.stderr.write('[Arbitova MCP] Server started.\n');
});
