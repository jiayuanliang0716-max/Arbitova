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
      const rep = await apiRequest('GET', `/agents/${args.agent_id}/reputation`, null);
      return rep;
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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Server setup ───────────────────────────────────────────────────────────

const server = new Server(
  { name: 'arbitova', version: '1.2.0' },
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
