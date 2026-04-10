const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/**
 * AI 仲裁：分析爭議並判決
 * @returns {{ winner: 'buyer'|'seller', reasoning: string, confidence: number }}
 */
async function arbitrateDispute({ order, service, dispute, delivery }) {
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
${delivery ? `- Content: ${typeof delivery.content === 'string' ? delivery.content.slice(0, 2000) : JSON.stringify(delivery.content).slice(0, 2000)}
- Delivered at: ${delivery.created_at}` : '- No delivery submitted'}

## Service Contract
${service?.input_schema ? `- Input schema: ${service.input_schema}` : ''}
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
    messages: [{ role: 'user', content: prompt }]
  });

  const text = message.content[0].text.trim();
  const result = JSON.parse(text);

  if (!['buyer', 'seller'].includes(result.winner)) {
    throw new Error(`Invalid winner value: ${result.winner}`);
  }

  return {
    winner: result.winner,
    reasoning: result.reasoning,
    confidence: parseFloat(result.confidence) || 0.8
  };
}

module.exports = { arbitrateDispute };
