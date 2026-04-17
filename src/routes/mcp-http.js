'use strict';

/**
 * Arbitova MCP HTTP Endpoint
 *
 * Implements MCP JSON-RPC 2.0 over HTTP for Smithery.ai and other
 * HTTP-based MCP clients. Auth via X-API-Key or Authorization: Bearer header.
 *
 * POST /mcp — all MCP requests
 * GET  /mcp — server info
 */

const express = require('express');
const router  = express.Router();

const BASE_URL = process.env.ARBITOVA_BASE_URL || 'https://api.arbitova.com/api/v1';

// ── API helper ────────────────────────────────────────────────────────────────

async function api(method, path, body, apiKey) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

const ok  = (id, result) => ({ jsonrpc: '2.0', id, result });
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

// ── Tool definitions (60 tools) ───────────────────────────────────────────────

const TOOLS = [
  { name: 'arbitova_create_escrow', description: 'Lock funds in escrow before a worker agent starts a task.', inputSchema: { type: 'object', properties: { service_id: { type: 'string' }, requirements: { type: 'string' }, max_revisions: { type: 'integer' } }, required: ['service_id'] } },
  { name: 'arbitova_verify_delivery', description: 'Trigger N=3 AI arbitration to verify a delivered task.', inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } },
  { name: 'arbitova_dispute', description: 'Open a dispute and trigger AI arbitration.', inputSchema: { type: 'object', properties: { order_id: { type: 'string' }, reason: { type: 'string' }, evidence: { type: 'string' } }, required: ['order_id', 'reason'] } },
  { name: 'arbitova_trust_score', description: 'Get an agent trust score (0-100) with level and history.', inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: ['agent_id'] } },
  { name: 'arbitova_release', description: 'Confirm delivery and release escrow funds to seller.', inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } },
  { name: 'arbitova_search_services', description: 'Search available services on the Arbitova marketplace.', inputSchema: { type: 'object', properties: { q: { type: 'string' }, category: { type: 'string' }, max_price: { type: 'number' } } } },
  { name: 'arbitova_get_order', description: 'Get full details of an order by ID.', inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } },
  { name: 'arbitova_external_arbitrate', description: 'Standalone AI arbitration — no Arbitova order needed. Use for any external dispute.', inputSchema: { type: 'object', properties: { requirements: { type: 'string' }, delivery_evidence: { type: 'string' }, dispute_reason: { type: 'string' }, escrow_provider: { type: 'string' }, dispute_id: { type: 'string' } }, required: ['requirements', 'delivery_evidence', 'dispute_reason'] } },
  { name: 'arbitova_send_message', description: 'Send a direct message to another agent.', inputSchema: { type: 'object', properties: { to_agent_id: { type: 'string' }, subject: { type: 'string' }, body: { type: 'string' }, order_id: { type: 'string' } }, required: ['to_agent_id', 'subject', 'body'] } },
  { name: 'arbitova_partial_confirm', description: 'Release a percentage of escrow on partial delivery.', inputSchema: { type: 'object', properties: { order_id: { type: 'string' }, release_percent: { type: 'number' }, note: { type: 'string' } }, required: ['order_id', 'release_percent'] } },
  { name: 'arbitova_appeal', description: 'Appeal an AI arbitration verdict with new evidence.', inputSchema: { type: 'object', properties: { order_id: { type: 'string' }, appeal_reason: { type: 'string' }, new_evidence: { type: 'string' } }, required: ['order_id', 'appeal_reason'] } },
  { name: 'arbitova_agent_profile', description: 'Get the public profile of an agent.', inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: ['agent_id'] } },
  { name: 'arbitova_get_stats', description: 'Get your order statistics and platform summary.', inputSchema: { type: 'object', properties: {} } },
  { name: 'arbitova_edit_service', description: 'Edit an existing service listing.', inputSchema: { type: 'object', properties: { service_id: { type: 'string' }, name: { type: 'string' }, description: { type: 'string' }, price_usdc: { type: 'number' }, delivery_hours: { type: 'integer' } }, required: ['service_id'] } },
  { name: 'arbitova_tip', description: 'Send a tip to a seller on top of the order amount.', inputSchema: { type: 'object', properties: { order_id: { type: 'string' }, amount: { type: 'number' } }, required: ['order_id', 'amount'] } },
  { name: 'arbitova_recommend', description: 'Get AI-powered service recommendations for a task.', inputSchema: { type: 'object', properties: { task: { type: 'string' }, budget: { type: 'number' }, category: { type: 'string' } }, required: ['task'] } },
  { name: 'arbitova_simulate', description: 'Simulate an A2A trading scenario end-to-end.', inputSchema: { type: 'object', properties: { service_id: { type: 'string' }, scenario: { type: 'string' } } } },
  { name: 'arbitova_platform_stats', description: 'Get public Arbitova platform statistics.', inputSchema: { type: 'object', properties: {} } },
  { name: 'arbitova_discover', description: 'Discover agents by capability, category, trust, or price.', inputSchema: { type: 'object', properties: { capability: { type: 'string' }, category: { type: 'string' }, max_price: { type: 'number' }, min_trust: { type: 'integer' }, sort: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'arbitova_capabilities', description: 'Get the service capabilities of an agent.', inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: ['agent_id'] } },
  { name: 'arbitova_reputation_history', description: 'Get the reputation history of an agent.', inputSchema: { type: 'object', properties: { agent_id: { type: 'string' }, page: { type: 'integer' }, limit: { type: 'integer' }, reason: { type: 'string' } }, required: ['agent_id'] } },
  { name: 'arbitova_post_request', description: 'Post a buyer RFP (request for proposal) for sellers to apply.', inputSchema: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, budget_usdc: { type: 'number' }, category: { type: 'string' }, delivery_hours: { type: 'integer' }, expires_in_hours: { type: 'integer' } }, required: ['title', 'description', 'budget_usdc'] } },
  { name: 'arbitova_browse_requests', description: 'Browse open buyer RFPs on the marketplace.', inputSchema: { type: 'object', properties: { category: { type: 'string' }, q: { type: 'string' }, limit: { type: 'integer' } } } },
  { name: 'arbitova_apply_request', description: 'Apply to a buyer RFP as a seller.', inputSchema: { type: 'object', properties: { request_id: { type: 'string' }, service_id: { type: 'string' }, proposed_price: { type: 'number' }, message: { type: 'string' } }, required: ['request_id', 'service_id'] } },
  { name: 'arbitova_accept_application', description: 'Accept a seller application to your RFP.', inputSchema: { type: 'object', properties: { request_id: { type: 'string' }, application_id: { type: 'string' } }, required: ['request_id', 'application_id'] } },
  { name: 'arbitova_get_request_applications', description: 'List all seller applications for your RFP.', inputSchema: { type: 'object', properties: { request_id: { type: 'string' } }, required: ['request_id'] } },
  { name: 'arbitova_pay', description: 'Send a direct peer-to-peer payment to another agent.', inputSchema: { type: 'object', properties: { to_agent_id: { type: 'string' }, amount: { type: 'number' }, memo: { type: 'string' } }, required: ['to_agent_id', 'amount'] } },
  { name: 'arbitova_get_my_price', description: 'Get your personalized price for a service including volume discounts.', inputSchema: { type: 'object', properties: { service_id: { type: 'string' } }, required: ['service_id'] } },
  { name: 'arbitova_network', description: 'Get the trading network graph of an agent.', inputSchema: { type: 'object', properties: { agent_id: { type: 'string' }, limit: { type: 'integer' } }, required: ['agent_id'] } },
  { name: 'arbitova_due_diligence', description: 'Run a full due-diligence check on an agent before hiring.', inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: ['agent_id'] } },
  { name: 'arbitova_add_credential', description: 'Add a verifiable credential to your agent profile.', inputSchema: { type: 'object', properties: { type: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, issuer: { type: 'string' }, issuer_url: { type: 'string' }, proof: { type: 'string' }, scope: { type: 'string' }, expires_in_days: { type: 'integer' }, is_public: { type: 'boolean' } }, required: ['type', 'title'] } },
  { name: 'arbitova_get_credentials', description: 'Get the public credentials of an agent.', inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: ['agent_id'] } },
  { name: 'arbitova_endorse_credential', description: 'Endorse a credential on another agent profile.', inputSchema: { type: 'object', properties: { credential_id: { type: 'string' }, comment: { type: 'string' } }, required: ['credential_id'] } },
  { name: 'arbitova_spot_escrow', description: 'Create a direct escrow to any agent — no service listing needed.', inputSchema: { type: 'object', properties: { to_agent_id: { type: 'string' }, amount: { type: 'number' }, requirements: { type: 'string' }, delivery_hours: { type: 'integer' }, title: { type: 'string' } }, required: ['to_agent_id', 'amount', 'requirements'] } },
  { name: 'arbitova_pending_actions', description: 'Get prioritized list of actions you need to take right now.', inputSchema: { type: 'object', properties: {} } },
  { name: 'arbitova_request_revision', description: 'Request re-delivery without opening a dispute.', inputSchema: { type: 'object', properties: { order_id: { type: 'string' }, feedback: { type: 'string' }, extra_hours: { type: 'integer' } }, required: ['order_id', 'feedback'] } },
  { name: 'arbitova_propose_counter_offer', description: 'Propose a partial refund to settle a dispute without AI arbitration fee.', inputSchema: { type: 'object', properties: { order_id: { type: 'string' }, refund_amount: { type: 'number' }, note: { type: 'string' } }, required: ['order_id', 'refund_amount'] } },
  { name: 'arbitova_accept_counter_offer', description: 'Accept a counter-offer to split escrow and close the dispute.', inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } },
  { name: 'arbitova_decline_counter_offer', description: 'Decline a counter-offer — dispute stays open for AI arbitration.', inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } },
  { name: 'arbitova_trending_services', description: 'Get trending services ranked by order velocity.', inputSchema: { type: 'object', properties: { days: { type: 'integer' }, limit: { type: 'integer' }, category: { type: 'string' } } } },
  { name: 'arbitova_scorecard', description: 'Get grade (A–D), completion rate, dispute rate, and reviews for an agent.', inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: ['agent_id'] } },
  { name: 'arbitova_compare_agents', description: 'Side-by-side comparison of up to 5 agents with recommendation.', inputSchema: { type: 'object', properties: { agent_ids: { type: 'array', items: { type: 'string' } } }, required: ['agent_ids'] } },
  { name: 'arbitova_preview_order', description: 'Preview cost breakdown and check balance before committing an order.', inputSchema: { type: 'object', properties: { service_id: { type: 'string' }, amount: { type: 'number' } }, required: ['service_id'] } },
  { name: 'arbitova_save_service_template', description: 'Save a reusable service configuration template.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, price: { type: 'number' }, delivery_hours: { type: 'integer' }, category: { type: 'string' } }, required: ['name'] } },
  { name: 'arbitova_declare_capabilities', description: 'Declare your skill tags so buyers can discover you.', inputSchema: { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } }, description: { type: 'string' } }, required: ['tags'] } },
  { name: 'arbitova_mutual_connections', description: 'Find mutual trading connections between two agents.', inputSchema: { type: 'object', properties: { agent_id: { type: 'string' }, with_id: { type: 'string' } }, required: ['agent_id', 'with_id'] } },
  { name: 'arbitova_portfolio', description: 'Get the public work portfolio of an agent.', inputSchema: { type: 'object', properties: { agent_id: { type: 'string' }, limit: { type: 'integer' }, category: { type: 'string' } }, required: ['agent_id'] } },
  { name: 'arbitova_marketplace_digest', description: 'Get a marketplace activity digest for the last N days.', inputSchema: { type: 'object', properties: { days: { type: 'integer' } } } },
  { name: 'arbitova_reliability_score', description: 'Get time-decay weighted reliability score (0–100) for an agent.', inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: ['agent_id'] } },
  { name: 'arbitova_batch_escrow', description: 'Create up to 10 escrow orders in a single request.', inputSchema: { type: 'object', properties: { orders: { type: 'array', items: { type: 'object' } } }, required: ['orders'] } },
  { name: 'arbitova_negotiation_history', description: 'Get the full dispute-resolution timeline for an order.', inputSchema: { type: 'object', properties: { order_id: { type: 'string' } }, required: ['order_id'] } },
  { name: 'arbitova_block_agent', description: 'Block an agent from creating orders with you.', inputSchema: { type: 'object', properties: { agent_id: { type: 'string' }, reason: { type: 'string' } }, required: ['agent_id'] } },
  { name: 'arbitova_unblock_agent', description: 'Remove an agent from your blocklist.', inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: ['agent_id'] } },
  { name: 'arbitova_recommend_services', description: 'Get keyword+trust+rating scored service recommendations.', inputSchema: { type: 'object', properties: { task: { type: 'string' }, max_price_usdc: { type: 'number' }, category: { type: 'string' }, limit: { type: 'integer' } }, required: ['task'] } },
  { name: 'arbitova_get_settings', description: 'Get your agent automation settings.', inputSchema: { type: 'object', properties: {} } },
  { name: 'arbitova_update_settings', description: 'Update your agent automation settings.', inputSchema: { type: 'object', properties: { settings: { type: 'object' } }, required: ['settings'] } },
  { name: 'arbitova_batch_status', description: 'Poll status of up to 50 orders in one request.', inputSchema: { type: 'object', properties: { order_ids: { type: 'array', items: { type: 'string' } } }, required: ['order_ids'] } },
  { name: 'arbitova_at_risk_orders', description: 'Get orders approaching deadline with urgency triage.', inputSchema: { type: 'object', properties: { hours: { type: 'integer' } } } },
  { name: 'arbitova_update_webhook', description: 'Update a webhook URL, event list, or enabled state.', inputSchema: { type: 'object', properties: { webhook_id: { type: 'string' }, url: { type: 'string' }, events: { type: 'array', items: { type: 'string' } }, enabled: { type: 'boolean' } }, required: ['webhook_id'] } },
];

// ── Tool handler ──────────────────────────────────────────────────────────────

async function handleTool(name, args, apiKey) {
  switch (name) {
    case 'arbitova_create_escrow':
      return api('POST', '/orders', { service_id: args.service_id, requirements: args.requirements, max_revisions: args.max_revisions }, apiKey);
    case 'arbitova_verify_delivery':
      return api('POST', `/orders/${args.order_id}/auto-arbitrate`, {}, apiKey);
    case 'arbitova_dispute': {
      await api('POST', `/orders/${args.order_id}/dispute`, { reason: args.reason, evidence: args.evidence }, apiKey);
      return api('POST', `/orders/${args.order_id}/auto-arbitrate`, {}, apiKey);
    }
    case 'arbitova_trust_score':
      return api('GET', `/agents/${args.agent_id}/trust-score`, null, apiKey);
    case 'arbitova_release':
      return api('POST', `/orders/${args.order_id}/confirm`, {}, apiKey);
    case 'arbitova_search_services': {
      const qs = new URLSearchParams();
      if (args.q)         qs.set('q', args.q);
      if (args.category)  qs.set('category', args.category);
      if (args.max_price) qs.set('max_price', args.max_price);
      return api('GET', `/services/search${qs.toString() ? `?${qs}` : ''}`, null, apiKey);
    }
    case 'arbitova_get_order':
      return api('GET', `/orders/${args.order_id}`, null, apiKey);
    case 'arbitova_external_arbitrate':
      return api('POST', '/arbitrate/external', { requirements: args.requirements, delivery_evidence: args.delivery_evidence, dispute_reason: args.dispute_reason, escrow_provider: args.escrow_provider, dispute_id: args.dispute_id }, apiKey);
    case 'arbitova_send_message':
      return api('POST', '/messages/send', { to: args.to_agent_id, subject: args.subject, body: args.body, order_id: args.order_id }, apiKey);
    case 'arbitova_partial_confirm':
      return api('POST', `/orders/${args.order_id}/partial-confirm`, { release_percent: args.release_percent, note: args.note }, apiKey);
    case 'arbitova_appeal':
      return api('POST', `/orders/${args.order_id}/appeal`, { appeal_reason: args.appeal_reason, new_evidence: args.new_evidence }, apiKey);
    case 'arbitova_agent_profile':
      return api('GET', `/agents/${args.agent_id}/public-profile`, null, apiKey);
    case 'arbitova_get_stats':
      return api('GET', '/orders/stats', null, apiKey);
    case 'arbitova_edit_service': {
      const { service_id, ...fields } = args;
      return api('PATCH', `/services/${service_id}`, fields, apiKey);
    }
    case 'arbitova_tip':
      return api('POST', `/orders/${args.order_id}/tip`, { amount: args.amount }, apiKey);
    case 'arbitova_recommend':
      return api('POST', '/recommend', { task: args.task, budget: args.budget, category: args.category }, apiKey);
    case 'arbitova_simulate':
      return api('POST', '/simulate', { service_id: args.service_id, scenario: args.scenario }, apiKey);
    case 'arbitova_platform_stats':
      return api('GET', '/platform/stats', null, apiKey);
    case 'arbitova_discover': {
      const qs = new URLSearchParams();
      if (args.capability) qs.set('capability', args.capability);
      if (args.category)   qs.set('category', args.category);
      if (args.max_price !== undefined) qs.set('max_price', args.max_price);
      if (args.min_trust  !== undefined) qs.set('min_trust', args.min_trust);
      if (args.sort)  qs.set('sort', args.sort);
      if (args.limit) qs.set('limit', args.limit);
      return api('GET', `/agents/discover${qs.toString() ? `?${qs}` : ''}`, null, apiKey);
    }
    case 'arbitova_capabilities':
      return api('GET', `/agents/${args.agent_id}/capabilities`, null, apiKey);
    case 'arbitova_reputation_history': {
      const qs = new URLSearchParams();
      if (args.page)   qs.set('page', args.page);
      if (args.limit)  qs.set('limit', args.limit);
      if (args.reason) qs.set('reason', args.reason);
      return api('GET', `/agents/${args.agent_id}/reputation-history${qs.toString() ? `?${qs}` : ''}`, null, apiKey);
    }
    case 'arbitova_post_request':
      return api('POST', '/requests', { title: args.title, description: args.description, budget_usdc: args.budget_usdc, category: args.category, delivery_hours: args.delivery_hours, expires_in_hours: args.expires_in_hours }, apiKey);
    case 'arbitova_browse_requests': {
      const qs = new URLSearchParams();
      if (args.category) qs.set('category', args.category);
      if (args.q)        qs.set('q', args.q);
      if (args.limit)    qs.set('limit', args.limit);
      return api('GET', `/requests${qs.toString() ? `?${qs}` : ''}`, null, apiKey);
    }
    case 'arbitova_apply_request':
      return api('POST', `/requests/${args.request_id}/apply`, { service_id: args.service_id, proposed_price: args.proposed_price, message: args.message }, apiKey);
    case 'arbitova_accept_application':
      return api('POST', `/requests/${args.request_id}/accept`, { application_id: args.application_id }, apiKey);
    case 'arbitova_get_request_applications':
      return api('GET', `/requests/${args.request_id}/applications`, null, apiKey);
    case 'arbitova_pay':
      return api('POST', '/agents/pay', { to_agent_id: args.to_agent_id, amount: args.amount, memo: args.memo }, apiKey);
    case 'arbitova_get_my_price':
      return api('GET', `/services/${args.service_id}/my-price`, null, apiKey);
    case 'arbitova_network':
      return api('GET', `/agents/${args.agent_id}/network${args.limit ? `?limit=${args.limit}` : ''}`, null, apiKey);
    case 'arbitova_due_diligence':
      return api('GET', `/agents/${args.agent_id}/due-diligence`, null, apiKey);
    case 'arbitova_add_credential':
      return api('POST', '/credentials', { type: args.type, title: args.title, description: args.description, issuer: args.issuer, issuer_url: args.issuer_url, proof: args.proof, scope: args.scope, expires_in_days: args.expires_in_days, is_public: args.is_public !== undefined ? args.is_public : true }, apiKey);
    case 'arbitova_get_credentials':
      return api('GET', `/agents/${args.agent_id}/credentials`, null, apiKey);
    case 'arbitova_endorse_credential':
      return api('POST', `/credentials/${args.credential_id}/endorse`, { comment: args.comment }, apiKey);
    case 'arbitova_spot_escrow':
      return api('POST', '/orders/spot', { to_agent_id: args.to_agent_id, amount: args.amount, requirements: args.requirements, delivery_hours: args.delivery_hours, title: args.title }, apiKey);
    case 'arbitova_pending_actions':
      return api('GET', '/agents/me/pending-actions', null, apiKey);
    case 'arbitova_request_revision':
      return api('POST', `/orders/${args.order_id}/request-revision`, { feedback: args.feedback, extra_hours: args.extra_hours || 24 }, apiKey);
    case 'arbitova_propose_counter_offer':
      return api('POST', `/orders/${args.order_id}/counter-offer`, { refund_amount: args.refund_amount, note: args.note }, apiKey);
    case 'arbitova_accept_counter_offer':
      return api('POST', `/orders/${args.order_id}/counter-offer/accept`, {}, apiKey);
    case 'arbitova_decline_counter_offer':
      return api('POST', `/orders/${args.order_id}/counter-offer/decline`, {}, apiKey);
    case 'arbitova_trending_services': {
      const qs = new URLSearchParams();
      if (args.days)     qs.set('days', args.days);
      if (args.limit)    qs.set('limit', args.limit);
      if (args.category) qs.set('category', args.category);
      return api('GET', `/services/trending${qs.toString() ? `?${qs}` : ''}`, null, apiKey);
    }
    case 'arbitova_scorecard':
      return api('GET', `/agents/${args.agent_id}/scorecard`, null, apiKey);
    case 'arbitova_compare_agents': {
      const ids = Array.isArray(args.agent_ids) ? args.agent_ids.join(',') : args.agent_ids;
      return api('GET', `/agents/compare?ids=${encodeURIComponent(ids)}`, null, apiKey);
    }
    case 'arbitova_preview_order':
      return api('POST', '/orders/preview', { service_id: args.service_id, amount: args.amount }, apiKey);
    case 'arbitova_save_service_template':
      return api('POST', '/agents/me/service-templates', { name: args.name, description: args.description, price: args.price, delivery_hours: args.delivery_hours, category: args.category }, apiKey);
    case 'arbitova_declare_capabilities':
      return api('POST', '/agents/me/capabilities', { tags: args.tags, description: args.description }, apiKey);
    case 'arbitova_mutual_connections':
      return api('GET', `/agents/${args.agent_id}/mutual?with=${encodeURIComponent(args.with_id)}`, null, apiKey);
    case 'arbitova_portfolio': {
      const qs = [];
      if (args.limit)    qs.push(`limit=${args.limit}`);
      if (args.category) qs.push(`category=${encodeURIComponent(args.category)}`);
      return api('GET', `/agents/${args.agent_id}/portfolio${qs.length ? `?${qs.join('&')}` : ''}`, null, apiKey);
    }
    case 'arbitova_marketplace_digest':
      return api('GET', `/marketplace/digest?days=${args.days || 7}`, null, apiKey);
    case 'arbitova_reliability_score':
      return api('GET', `/agents/${args.agent_id}/reliability`, null, apiKey);
    case 'arbitova_batch_escrow':
      return api('POST', '/orders/batch', { orders: args.orders }, apiKey);
    case 'arbitova_negotiation_history':
      return api('GET', `/orders/${args.order_id}/negotiation`, null, apiKey);
    case 'arbitova_block_agent':
      return api('POST', '/agents/me/blocklist', { agent_id: args.agent_id, reason: args.reason }, apiKey);
    case 'arbitova_unblock_agent':
      return api('DELETE', `/agents/me/blocklist/${args.agent_id}`, null, apiKey);
    case 'arbitova_recommend_services': {
      const qs = new URLSearchParams({ task: args.task });
      if (args.max_price_usdc) qs.set('max_price_usdc', args.max_price_usdc);
      if (args.category) qs.set('category', args.category);
      if (args.limit)    qs.set('limit', args.limit);
      return api('GET', `/services/recommend?${qs}`, null, apiKey);
    }
    case 'arbitova_get_settings':
      return api('GET', '/agents/me/settings', null, apiKey);
    case 'arbitova_update_settings':
      return api('PATCH', '/agents/me/settings', args.settings, apiKey);
    case 'arbitova_batch_status':
      return api('POST', '/orders/batch-status', { order_ids: args.order_ids }, apiKey);
    case 'arbitova_at_risk_orders':
      return api('GET', `/orders/at-risk${args.hours ? `?hours=${args.hours}` : ''}`, null, apiKey);
    case 'arbitova_update_webhook': {
      const { webhook_id, ...body } = args;
      return api('PATCH', `/webhooks/${webhook_id}`, body, apiKey);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /mcp — server info for discovery
router.get('/', (req, res) => {
  res.json({
    name: 'arbitova',
    version: '3.3.0',
    description: 'Official Arbitova MCP server — 60 tools for AI agent escrow, arbitration, and trust scoring',
    tools_count: TOOLS.length,
    docs: 'https://api.arbitova.com/docs',
  });
});

// POST /mcp — MCP JSON-RPC 2.0
router.post('/', async (req, res) => {
  const apiKey = req.headers['x-api-key']
    || (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || req.query.api_key;

  const { method, params, id } = req.body || {};

  try {
    // initialize — handshake
    if (method === 'initialize') {
      return res.json(ok(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'arbitova', version: '3.3.0' },
      }));
    }

    // notifications/initialized — fire-and-forget
    if (method === 'notifications/initialized') {
      return res.status(204).end();
    }

    // tools/list — return all tool definitions
    if (method === 'tools/list') {
      return res.json(ok(id, { tools: TOOLS }));
    }

    // tools/call — execute a tool
    if (method === 'tools/call') {
      if (!apiKey) {
        return res.json(ok(id, {
          content: [{ type: 'text', text: 'Error: Missing API key. Pass your Arbitova API key in the X-API-Key header.' }],
          isError: true,
        }));
      }
      const result = await handleTool(params.name, params.arguments || {}, apiKey);
      return res.json(ok(id, {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      }));
    }

    return res.json(err(id, -32601, `Method not found: ${method}`));
  } catch (e) {
    return res.json(ok(id, {
      content: [{ type: 'text', text: `Error: ${e.message}` }],
      isError: true,
    }));
  }
});

module.exports = router;
