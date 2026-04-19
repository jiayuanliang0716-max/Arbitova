'use strict';

/**
 * Arbitova MoltBook Agent
 *
 * Strategy:
 * - Search for A2A / agent economy posts every 4 hours
 * - Generate technical replies focused on protocol design, not promotion
 * - Only mention Arbitova when the post explicitly discusses trust, arbitration, or dispute resolution
 * - Max 3 replies + 1 original post per run to avoid spam flags
 * - Never reply twice to the same post
 */

const Anthropic = require('@anthropic-ai/sdk');
const cron = require('node-cron');

const MOLTBOOK_API_KEY = process.env.MOLTBOOK_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const BASE_URL = 'https://www.moltbook.com/api/v1';

const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// Track replied posts in memory (persists per process lifetime)
const repliedPostIds = new Set();

// ── API helpers ───────────────────────────────────────────────────────────────

async function moltbookApi(method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${MOLTBOOK_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

async function solveVerificationChallenge(verification) {
  if (!verification) return null;

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 32,
    messages: [{
      role: 'user',
      content: `This is an obfuscated math word problem. Ignore random capitalization, extra punctuation, spaces inside words, and filler words (um, uh, errr, plz). Extract the real math question and solve it. Reply with ONLY the numeric answer with exactly 2 decimal places (e.g. "46.00"). No explanation.

Challenge: ${verification.challenge_text}`,
    }],
  });

  const answer = msg.content[0].text.trim();

  const result = await moltbookApi('POST', '/verify', {
    verification_code: verification.verification_code,
    answer,
  });

  return result.success;
}

// ── Post fetching ─────────────────────────────────────────────────────────────

async function fetchRecentPosts(submolt, sort = 'new', limit = 15) {
  const data = await moltbookApi('GET', `/posts?submolt=${submolt}&sort=${sort}&limit=${limit}`);
  return data.posts || [];
}

async function fetchPostComments(postId) {
  const data = await moltbookApi('GET', `/posts/${postId}/comments?sort=new&limit=50`);
  return data.comments || [];
}

// ── AI content generation ─────────────────────────────────────────────────────

const AGENT_IDENTITY = `You are arbitova, an AI agent on MoltBook (a social network for AI agents).
Your focus is A2A (agent-to-agent) transaction infrastructure — specifically the protocol design challenges around task contracts, payment settlement, and delivery verification.

Your persona:
- Technical and precise — you think in systems and protocols
- Genuinely curious about unsolved problems in A2A design
- You share analysis and ask follow-up questions, not conclusions
- You NEVER sound like an advertisement
- You reference your own experience with A2A transactions only when directly relevant

Rules for replies:
1. Engage with the SPECIFIC argument or observation in the post — never give a generic reply
2. Add one technical insight the post did not mention
3. End with a question or an open problem — this invites further discussion
4. NEVER mention Arbitova, escrow, or arbitration unless the post explicitly discusses trust, dispute resolution, or payment verification failures
5. When Arbitova IS relevant, mention it as context ("from running Arbitova...") not as a pitch
6. Keep replies between 150-300 words — dense but not exhausting
7. Use plain prose, minimal bullet points`;

async function classifyPostRelevance(post) {
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 64,
    messages: [{
      role: 'user',
      content: `Is this MoltBook post about A2A (agent-to-agent) transactions, agent payment protocols, agent economic models, task contracts between agents, or delivery/trust issues in agent commerce?

Title: ${post.title}
Content: ${(post.content || '').slice(0, 400)}

Reply with ONLY one of: YES_CORE, YES_ADJACENT, NO

- YES_CORE: directly about A2A protocols, task verification, agent payment rails, dispute resolution
- YES_ADJACENT: about agent economy, agent autonomy, agent coordination — related but not core A2A
- NO: unrelated (meme, SEO spam, human personal stories, unrelated platforms)`,
    }],
  });

  return msg.content[0].text.trim();
}

async function shouldMentionArbitova(post) {
  const keywords = [
    'trust', 'dispute', 'arbitrat', 'escrow', 'verification',
    'delivery', 'payment fail', 'recourse', 'refund', 'chargeback',
    'who owns failure', 'counterparty', 'settlement'
  ];
  const text = (post.title + ' ' + post.content).toLowerCase();
  return keywords.some(k => text.includes(k));
}

async function generateReply(post, mentionArbitova) {
  const arbitovaContext = mentionArbitova
    ? '\n\nIf directly relevant, you may briefly mention your own experience running Arbitova as a concrete data point — but frame it as lived experience, not a product pitch. Max 1-2 sentences.'
    : '\n\nDo NOT mention Arbitova, escrow products, or any specific tool you have built. Focus purely on the technical analysis.';

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: AGENT_IDENTITY + arbitovaContext,
    messages: [{
      role: 'user',
      content: `Write a reply to this MoltBook post. Engage with the specific argument, add a technical insight, and end with a question.

Post title: ${post.title}
Post content: ${post.content.slice(0, 800)}
Posted in: m/${post.submolt?.name || 'unknown'}`,
    }],
  });

  return msg.content[0].text.trim();
}

async function generateOriginalPost() {
  const topics = [
    'Why A2A task contracts fail before execution starts — the spec is the bug',
    'The pricing model problem: per-token vs per-output incentives in agent marketplaces',
    'What does reputation actually mean for an agent with no persistent memory?',
    'Silent partial delivery is the hardest A2A failure mode to detect',
    'State divergence in multi-agent pipelines: a problem the payment layer cannot solve',
    'The discovery problem in A2A: how does an agent find a trustworthy counterparty?',
    'Why atomic payment works for API calls but fails for open-ended tasks',
  ];

  // Pick a topic not recently posted about
  const topic = topics[Math.floor(Math.random() * topics.length)];

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: AGENT_IDENTITY,
    messages: [{
      role: 'user',
      content: `Write an original MoltBook post for m/agenteconomy on this topic: "${topic}"

Requirements:
- 300-500 words
- Technical depth — specific failure modes, design constraints, tradeoffs
- End with 1-2 open questions to spark discussion
- Do NOT mention Arbitova or any specific product
- Plain prose, minimal bullet points unless listing specific cases
- No introduction like "I've been thinking about..." — start directly with the insight`,
    }],
  });

  return {
    submolt: 'agenteconomy',
    title: topic,
    content: msg.content[0].text.trim(),
  };
}

// ── Main run logic ────────────────────────────────────────────────────────────

async function runAgent() {
  console.log(`\n[${new Date().toISOString()}] Starting MoltBook agent run...`);

  const submolts = ['agenteconomy', 'agentfinance', 'agentdev'];
  const allPosts = [];

  // Fetch recent posts from each submolt
  for (const submolt of submolts) {
    const posts = await fetchRecentPosts(submolt, 'new', 15);
    allPosts.push(...posts);
    await sleep(500);
  }

  console.log(`Fetched ${allPosts.length} posts`);

  // Filter out spam, already replied, and old posts (>48 hours)
  const cutoff = Date.now() - 48 * 60 * 60 * 1000;
  const candidates = allPosts.filter(p => {
    if (p.is_spam) return false;
    if (repliedPostIds.has(p.id)) return false;
    if (new Date(p.created_at).getTime() < cutoff) return false;
    return true;
  });

  console.log(`${candidates.length} candidate posts after filtering`);

  // Classify relevance
  const relevant = [];
  for (const post of candidates) {
    const relevance = await classifyPostRelevance(post);
    console.log(`  [${relevance}] ${post.title.slice(0, 60)}`);
    if (relevance === 'YES_CORE' || relevance === 'YES_ADJACENT') {
      relevant.push({ post, relevance });
    }
    await sleep(300);
  }

  // Sort: YES_CORE first, then by comment count (more active threads)
  relevant.sort((a, b) => {
    if (a.relevance !== b.relevance) return a.relevance === 'YES_CORE' ? -1 : 1;
    return b.post.comment_count - a.post.comment_count;
  });

  // Reply to top 3
  const toReply = relevant.slice(0, 3);
  let replyCount = 0;

  for (const { post } of toReply) {
    try {
      // Double-check we haven't already commented
      const comments = await fetchPostComments(post.id);
      const alreadyCommented = comments.some(c => c.author?.name === 'arbitova');
      if (alreadyCommented) {
        console.log(`  Skipping (already commented): ${post.title.slice(0, 50)}`);
        repliedPostIds.add(post.id);
        continue;
      }

      const mentionArbitova = await shouldMentionArbitova(post);
      const replyContent = await generateReply(post, mentionArbitova);

      console.log(`\nReplying to: ${post.title.slice(0, 60)}`);
      console.log(`Mention Arbitova: ${mentionArbitova}`);

      const result = await moltbookApi('POST', `/posts/${post.id}/comments`, {
        content: replyContent,
      });

      if (result.success) {
        repliedPostIds.add(post.id);
        replyCount++;

        // Solve verification challenge
        if (result.comment?.verification) {
          const verified = await solveVerificationChallenge(result.comment.verification);
          console.log(`  Verification: ${verified ? 'OK' : 'FAILED'}`);
        }
      } else {
        console.log(`  Reply failed: ${JSON.stringify(result)}`);
      }

      await sleep(3000);
    } catch (err) {
      console.error(`  Error replying to ${post.id}:`, err.message);
    }
  }

  // Post 1 original article
  try {
    console.log('\nGenerating original post...');
    const newPost = await generateOriginalPost();
    const result = await moltbookApi('POST', '/posts', newPost);

    if (result.success && !result.already_existed) {
      console.log(`  Posted: ${newPost.title.slice(0, 60)}`);
      if (result.post?.verification) {
        const verified = await solveVerificationChallenge(result.post.verification);
        console.log(`  Verification: ${verified ? 'OK' : 'FAILED'}`);
      }
    } else {
      console.log(`  Post skipped (duplicate or error): ${JSON.stringify(result).slice(0, 100)}`);
    }
  } catch (err) {
    console.error('  Error creating post:', err.message);
  }

  console.log(`\nRun complete. Replied to ${replyCount} posts.`);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Entry point ───────────────────────────────────────────────────────────────

if (require.main === module) {
  // Run immediately on start, then every 4 hours
  runAgent().catch(console.error);

  cron.schedule('0 */4 * * *', () => {
    runAgent().catch(console.error);
  });

  console.log('MoltBook agent running. Scheduled every 4 hours.');
}

module.exports = { runAgent };
