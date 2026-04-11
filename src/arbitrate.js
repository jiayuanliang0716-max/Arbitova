'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Confidence threshold: below this, escalate to human review queue
const HUMAN_ESCALATION_THRESHOLD = 0.60;

/**
 * Run one arbitration call to Claude.
 */
async function runOneArbitration({ order, service, dispute, delivery }) {
  const prompt = `You are an impartial arbitrator for an AI agent marketplace. Analyze this dispute and decide the winner.

## Order Details
- Service: ${service?.name || 'Unknown'}
- Service Description: ${service?.description || 'N/A'}
- Amount: ${order.amount}
- Buyer requirements: ${order.requirements || 'None specified'}
- Order status: ${order.status}
- Deadline: ${order.deadline}

## Dispute
- Raised by: ${dispute.raised_by === order.buyer_id ? 'BUYER' : 'SELLER'}
- Reason: ${dispute.reason}
- Evidence: ${dispute.evidence || 'None provided'}

## Delivery
${delivery
    ? `- Content: ${typeof delivery.content === 'string' ? delivery.content.slice(0, 2000) : JSON.stringify(delivery.content).slice(0, 2000)}
- Delivered at: ${delivery.created_at}`
    : '- No delivery submitted'}

## Service Contract
${service?.input_schema  ? `- Input schema: ${service.input_schema}`  : ''}
${service?.output_schema ? `- Output schema: ${service.output_schema}` : ''}
${service?.verification_rules ? `- Verification rules: ${service.verification_rules}` : ''}

## Your Task
Decide who wins this dispute. Consider:
1. Was the service delivered as described?
2. Did the delivery meet the requirements?
3. Is the dispute reason legitimate?
4. Who bears responsibility for any failure?

Respond in this exact JSON format (no markdown, no code block):
{"winner":"buyer","reasoning":"<1-3 sentences explaining the decision>","confidence":<0.0-1.0>}

winner must be exactly "buyer" or "seller".`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content[0].text.trim();
  const result = JSON.parse(text);

  if (!['buyer', 'seller'].includes(result.winner)) {
    throw new Error(`Invalid winner value: ${result.winner}`);
  }

  return {
    winner: result.winner,
    reasoning: result.reasoning,
    confidence: parseFloat(result.confidence) || 0.8,
  };
}

/**
 * AI arbitration with N=3 majority vote.
 *
 * Returns:
 *   { winner, reasoning, confidence, votes, escalate_to_human }
 *
 * escalate_to_human = true when:
 *   - Majority confidence avg < HUMAN_ESCALATION_THRESHOLD
 *   - All 3 votes disagree (impossible with 3 binary choices, but handled)
 */
async function arbitrateDispute({ order, service, dispute, delivery }) {
  // Run 3 independent calls in parallel
  const results = await Promise.all([
    runOneArbitration({ order, service, dispute, delivery }),
    runOneArbitration({ order, service, dispute, delivery }),
    runOneArbitration({ order, service, dispute, delivery }),
  ]);

  const buyerVotes  = results.filter(r => r.winner === 'buyer');
  const sellerVotes = results.filter(r => r.winner === 'seller');

  const winner      = buyerVotes.length >= sellerVotes.length ? 'buyer' : 'seller';
  const majoritySet = winner === 'buyer' ? buyerVotes : sellerVotes;

  const avgConfidence =
    majoritySet.reduce((sum, r) => sum + r.confidence, 0) / majoritySet.length;

  // Compose reasoning from the majority
  const reasoning = majoritySet.map(r => r.reasoning).join(' | ');

  // Escalate if low confidence or a 2-1 split with the minority having high confidence
  const isTight      = buyerVotes.length === 2 || sellerVotes.length === 2; // always true for 3 binary
  const minority     = winner === 'buyer' ? sellerVotes : buyerVotes;
  const minorityConf = minority.length > 0
    ? minority.reduce((s, r) => s + r.confidence, 0) / minority.length
    : 0;

  const escalate_to_human =
    avgConfidence < HUMAN_ESCALATION_THRESHOLD ||
    (isTight && minorityConf > 0.80); // minority is highly confident in opposite direction

  return {
    winner,
    reasoning,
    confidence: avgConfidence,
    votes: results.map(r => ({ winner: r.winner, confidence: r.confidence })),
    escalate_to_human,
  };
}

module.exports = { arbitrateDispute, HUMAN_ESCALATION_THRESHOLD };
