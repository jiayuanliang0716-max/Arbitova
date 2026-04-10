#!/usr/bin/env node
// setup-catalog.js — One-time script to register seller agents and publish all services
// Usage: node scripts/setup-catalog.js

const { BASE_URL } = require('./config');
const { AGENTS, SERVICES, getServicesByCategory } = require('./catalog');

const RATE_LIMIT_DELAY = 300; // ms between API calls to avoid rate limiting

async function api(path, opts = {}, apiKey = null) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  const res = await fetch(`${BASE_URL}${path}`, { ...opts, headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || JSON.stringify(data));
  return data;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function registerAgent(agent) {
  try {
    const data = await api('/agents/register', {
      method: 'POST',
      body: JSON.stringify({
        name: agent.name,
        description: agent.description,
      }),
    });
    console.log(`  [OK] Registered "${agent.name}" => ID: ${data.id}`);
    return { id: data.id, key: data.api_key, name: agent.name, slug: agent.slug };
  } catch (err) {
    console.error(`  [FAIL] Register "${agent.name}": ${err.message}`);
    return null;
  }
}

async function publishService(service, agentKey) {
  const body = {
    name: service.name,
    description: service.description,
    price: service.price,
    delivery_hours: service.delivery_hours,
    product_type: service.product_type || 'ai_generated',
    market_type: service.market_type || 'h2a',
  };
  if (service.input_schema) body.input_schema = service.input_schema;
  if (service.output_schema) body.output_schema = service.output_schema;
  if (service.sub_interval) {
    body.sub_interval = service.sub_interval;
    body.sub_price = service.sub_price;
    body.product_type = 'subscription';
  }

  try {
    const data = await api('/services', {
      method: 'POST',
      body: JSON.stringify(body),
    }, agentKey);
    console.log(`    [OK] Published "${service.name}" => ID: ${data.id} ($${service.price})`);
    return { id: data.id, name: service.name, category: service.category, price: service.price };
  } catch (err) {
    console.error(`    [FAIL] Publish "${service.name}": ${err.message}`);
    return null;
  }
}

async function main() {
  console.log('=== A2A Market Catalog Setup ===');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Agents: ${AGENTS.length}`);
  console.log(`Services: ${SERVICES.length}`);
  console.log('');

  const registeredAgents = [];
  const publishedServices = [];

  // Step 1: Register all agents
  console.log('--- Step 1: Registering Seller Agents ---');
  for (const agent of AGENTS) {
    const result = await registerAgent(agent);
    if (result) registeredAgents.push(result);
    await sleep(RATE_LIMIT_DELAY);
  }
  console.log(`\nRegistered ${registeredAgents.length}/${AGENTS.length} agents.\n`);

  if (registeredAgents.length === 0) {
    console.error('No agents were registered. Aborting.');
    process.exit(1);
  }

  // Step 2: Publish services per agent
  console.log('--- Step 2: Publishing Services ---');
  for (const agent of registeredAgents) {
    const services = getServicesByCategory(agent.slug);
    console.log(`\n  [${agent.name}] — ${services.length} services`);
    for (const svc of services) {
      const result = await publishService(svc, agent.key);
      if (result) publishedServices.push({ ...result, agent_id: agent.id, agent_name: agent.name });
      await sleep(RATE_LIMIT_DELAY);
    }
  }

  // Step 3: Summary
  console.log('\n\n=== SETUP COMPLETE ===');
  console.log(`Agents registered: ${registeredAgents.length}`);
  console.log(`Services published: ${publishedServices.length}/${SERVICES.length}`);
  console.log('');

  // Print agent credentials (save these!)
  console.log('--- Agent Credentials (SAVE THESE) ---');
  for (const a of registeredAgents) {
    console.log(`  ${a.name} (${a.slug})`);
    console.log(`    ID:  ${a.id}`);
    console.log(`    Key: ${a.key}`);
  }
  console.log('');

  // Print service IDs by category
  console.log('--- Published Services ---');
  const byCategory = {};
  for (const s of publishedServices) {
    if (!byCategory[s.category]) byCategory[s.category] = [];
    byCategory[s.category].push(s);
  }
  for (const [cat, svcs] of Object.entries(byCategory)) {
    console.log(`\n  [${cat}]`);
    for (const s of svcs) {
      console.log(`    ${s.id} — ${s.name} ($${s.price})`);
    }
  }

  // Output JSON for programmatic use
  const output = {
    agents: registeredAgents.map(a => ({ slug: a.slug, id: a.id, key: a.key, name: a.name })),
    services: publishedServices,
  };
  console.log('\n--- JSON Output ---');
  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
