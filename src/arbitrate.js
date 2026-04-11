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
 * Tiebreaker logic for 2-1 splits.
 *
 * Strategy:
 *   1. If majority avg confidence − minority confidence >= 0.30 → majority wins (clear signal)
 *   2. Otherwise → run a 4th verifier as the deciding vote
 *
 * This keeps the normal 3-0 path at O(1) speed while giving 2-1 splits
 * a deterministic resolution without immediately burdening humans.
 */
async function resolveTiebreaker({ votes, winner, majoritySet, minority, context }) {
  const avgMajority = majoritySet.reduce((s, r) => s + r.confidence, 0) / majoritySet.length;
  const avgMinority = minority.length > 0
    ? minority.reduce((s, r) => s + r.confidence, 0) / minority.length
    : 0;

  // Clear signal: confidence gap >= 0.30 → trust the majority
  if (avgMajority - avgMinority >= 0.30) {
    return {
      winner,
      confidence: avgMajority,
      method: 'weighted_majority',
      votes,
    };
  }

  // Ambiguous: run a 4th verifier as the deciding vote
  const v4 = await runOneArbitration(context);
  const allVotes = [...votes, { winner: v4.winner, confidence: v4.confidence }];

  // Final tally after 4 votes
  const buyerTotal  = allVotes.filter(v => v.winner === 'buyer').length;
  const sellerTotal = allVotes.filter(v => v.winner === 'seller').length;
  const finalWinner = buyerTotal > sellerTotal ? 'buyer' : 'seller';
  const finalSet    = allVotes.filter(v => v.winner === finalWinner);
  const finalConf   = finalSet.reduce((s, v) => s + v.confidence, 0) / finalSet.length;

  return {
    winner: finalWinner,
    confidence: finalConf,
    method: 'fourth_verifier',
    votes: allVotes,
    fourth_vote: { winner: v4.winner, confidence: v4.confidence, reasoning: v4.reasoning },
  };
}

/**
 * AI arbitration with N=3 majority vote + tiebreaker.
 *
 * Returns:
 *   { winner, reasoning, confidence, votes, method, escalate_to_human }
 *
 * method: 'unanimous' | 'weighted_majority' | 'fourth_verifier'
 *
 * escalate_to_human = true when final confidence < HUMAN_ESCALATION_THRESHOLD
 */
async function arbitrateDispute({ order, service, dispute, delivery }) {
  const context = { order, service, dispute, delivery };

  // Run 3 independent calls in parallel
  const results = await Promise.all([
    runOneArbitration(context),
    runOneArbitration(context),
    runOneArbitration(context),
  ]);

  const buyerVotes  = results.filter(r => r.winner === 'buyer');
  const sellerVotes = results.filter(r => r.winner === 'seller');

  // 3-0 unanimous
  if (buyerVotes.length === 3 || sellerVotes.length === 3) {
    const winner    = buyerVotes.length === 3 ? 'buyer' : 'seller';
    const avgConf   = results.reduce((s, r) => s + r.confidence, 0) / 3;
    const reasoning = results.map(r => r.reasoning).join(' | ');
    return {
      winner,
      reasoning,
      confidence: avgConf,
      votes: results.map(r => ({ winner: r.winner, confidence: r.confidence })),
      method: 'unanimous',
      escalate_to_human: avgConf < HUMAN_ESCALATION_THRESHOLD,
    };
  }

  // 2-1 split: invoke tiebreaker
  const winner      = buyerVotes.length > sellerVotes.length ? 'buyer' : 'seller';
  const majoritySet = winner === 'buyer' ? buyerVotes : sellerVotes;
  const minority    = winner === 'buyer' ? sellerVotes : buyerVotes;

  const tb = await resolveTiebreaker({
    votes: results.map(r => ({ winner: r.winner, confidence: r.confidence })),
    winner,
    majoritySet,
    minority,
    context,
  });

  const reasoning = results
    .filter(r => r.winner === tb.winner)
    .map(r => r.reasoning)
    .join(' | ');

  return {
    winner: tb.winner,
    reasoning,
    confidence: tb.confidence,
    votes: tb.votes,
    method: tb.method,
    fourth_vote: tb.fourth_vote || null,
    escalate_to_human: tb.confidence < HUMAN_ESCALATION_THRESHOLD,
  };
}

module.exports = { arbitrateDispute, HUMAN_ESCALATION_THRESHOLD };
