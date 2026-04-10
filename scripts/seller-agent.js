// Seller Agent — auto-registers services and fulfills orders via Claude
// Supports multiple agent accounts (one per category) from the catalog

const { BASE_URL, SELLER } = require('./config');
const { SERVICES, AGENTS, getServicesByCategory } = require('./catalog');

const POLL_INTERVAL = 15000;
const processed = new Set();

// Runtime state: agent credentials loaded from config or setup
// Format: { slug: { id, key, name } }
let agentCredentials = {};

// Build a lookup: service name → catalog definition (with promptFn)
const SERVICE_DEFS = {};
for (const svc of SERVICES) {
  SERVICE_DEFS[svc.name] = svc;
}

async function api(path, opts = {}, apiKey = null) {
  const key = apiKey || SELLER.key;
  const res = await fetch(`${BASE_URL}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key, ...(opts.headers || {}) },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || JSON.stringify(data));
  return data;
}

// Register a new agent account for a category
async function registerAgent(agent) {
  try {
    const data = await api('/agents/register', {
      method: 'POST',
      body: JSON.stringify({ name: agent.name, description: agent.description }),
    }, 'skip'); // no auth needed for registration
    return { id: data.id, key: data.api_key, name: agent.name, slug: agent.slug };
  } catch (err) {
    console.error(`[register] Failed to register ${agent.name}: ${err.message}`);
    return null;
  }
}

// Register agent account via the public endpoint (no API key needed)
async function registerAgentPublic(agent) {
  const res = await fetch(`${BASE_URL}/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: agent.name, description: agent.description }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || JSON.stringify(data));
  return { id: data.id, key: data.api_key, name: agent.name, slug: agent.slug };
}

// Ensure all services for a given agent are registered
async function ensureServicesForAgent(agentSlug, agentId, agentKey) {
  const services = getServicesByCategory(agentSlug);
  try {
    const { services: existing } = await api('/services/search?sort=reputation', {}, agentKey);
    const myServices = existing.filter(s => s.agent_id === agentId);
    const myNames = new Set(myServices.map(s => s.name));

    for (const svc of services) {
      if (myNames.has(svc.name)) {
        console.log(`  [skip] Already listed: ${svc.name}`);
        continue;
      }
      const body = {
        name: svc.name,
        description: svc.description,
        price: svc.price,
        delivery_hours: svc.delivery_hours,
        product_type: svc.product_type || 'ai_generated',
        market_type: svc.market_type || 'h2a',
      };
      if (svc.input_schema) body.input_schema = svc.input_schema;
      if (svc.output_schema) body.output_schema = svc.output_schema;
      if (svc.sub_interval) {
        body.sub_interval = svc.sub_interval;
        body.sub_price = svc.sub_price;
        body.product_type = 'subscription';
      }
      try {
        const r = await api('/services', { method: 'POST', body: JSON.stringify(body) }, agentKey);
        console.log(`  [new] Published: ${svc.name} (ID: ${r.id})`);
      } catch (err) {
        console.error(`  [fail] ${svc.name}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[setup] Error checking services for ${agentSlug}: ${err.message}`);
  }
}

// Generate content via the platform's AI endpoint
async function generateReport(prompt, agentKey) {
  const key = agentKey || SELLER.key;
  const data = await api('/api/generate', {
    method: 'POST',
    body: JSON.stringify({ prompt }),
  }, key);
  return data.result;
}

// Find the catalog definition for an order's service
async function getServiceDef(serviceId, agentKey) {
  try {
    const svc = await api(`/services/${serviceId}`, {}, agentKey);
    if (!svc) return null;
    return SERVICE_DEFS[svc.name] || null;
  } catch {
    return null;
  }
}

// Process pending orders for one agent
async function processOrdersForAgent(agentId, agentKey, agentName) {
  try {
    const { orders } = await api(`/agents/${agentId}/orders`, {}, agentKey);
    const pending = orders.filter(o => o.status === 'paid' && !processed.has(o.id));

    for (const order of pending) {
      processed.add(order.id);
      console.log(`[${new Date().toLocaleTimeString()}] [${agentName}] Order: ${order.id}`);
      console.log(`  Service: ${order.service_name}`);
      console.log(`  Requirements: ${order.requirements || '(none)'}`);

      try {
        const def = await getServiceDef(order.service_id, agentKey);
        const prompt = def
          ? def.promptFn(order.requirements?.trim())
          : `Please fulfill this service request: ${order.requirements || '(no requirements provided)'}`;

        console.log(`  Generating...`);
        const report = await generateReport(prompt, agentKey);

        await api(`/orders/${order.id}/deliver`, {
          method: 'POST',
          body: JSON.stringify({ content: report }),
        }, agentKey);
        console.log(`  Delivered OK`);
      } catch (err) {
        console.error(`  Delivery failed: ${err.message}`);
        processed.delete(order.id); // retry next cycle
      }
    }
  } catch (err) {
    // Silently handle polling errors to avoid log spam
    if (!err.message.includes('not found')) {
      console.error(`[${new Date().toLocaleTimeString()}] [${agentName}] Poll error: ${err.message}`);
    }
  }
}

// Poll all agents for orders
async function pollAllOrders() {
  const agents = Object.values(agentCredentials);
  // Also include the original SELLER if configured
  if (SELLER.id && SELLER.key) {
    const hasOriginal = agents.some(a => a.id === SELLER.id);
    if (!hasOriginal) {
      agents.push({ id: SELLER.id, key: SELLER.key, name: 'Original Seller', slug: '_original' });
    }
  }
  await Promise.all(
    agents.map(a => processOrdersForAgent(a.id, a.key, a.name))
  );
}

// Load saved credentials from environment or use existing SELLER config
function loadCredentials() {
  // Check for AGENT_CREDENTIALS env var (JSON string from setup-catalog.js output)
  if (process.env.AGENT_CREDENTIALS) {
    try {
      const creds = JSON.parse(process.env.AGENT_CREDENTIALS);
      for (const c of creds) {
        agentCredentials[c.slug] = { id: c.id, key: c.key, name: c.name, slug: c.slug };
      }
      console.log(`Loaded ${Object.keys(agentCredentials).length} agent credentials from env.`);
      return true;
    } catch (err) {
      console.error('Failed to parse AGENT_CREDENTIALS:', err.message);
    }
  }

  // Fallback: use the single SELLER from config.js
  if (SELLER.id && SELLER.key) {
    agentCredentials['_default'] = {
      id: SELLER.id,
      key: SELLER.key,
      name: 'Default Seller',
      slug: '_default',
    };
    console.log('Using default SELLER credentials from config.js');
    return true;
  }

  return false;
}

async function main() {
  console.log('=== A2A Market Seller Agent ===');
  console.log(`API: ${BASE_URL}`);
  console.log(`Catalog: ${SERVICES.length} services across ${AGENTS.length} categories`);
  console.log('');

  // Load credentials
  const hasCredentials = loadCredentials();

  if (!hasCredentials) {
    console.log('No credentials found. Registering new agents...');
    for (const agent of AGENTS) {
      try {
        const cred = await registerAgentPublic(agent);
        agentCredentials[cred.slug] = cred;
        console.log(`  Registered: ${cred.name} (${cred.id})`);
      } catch (err) {
        console.error(`  Failed: ${agent.name}: ${err.message}`);
      }
    }
  }

  // Ensure all services are published
  console.log('\n--- Checking service listings ---');
  for (const [slug, cred] of Object.entries(agentCredentials)) {
    if (slug.startsWith('_')) continue; // skip internal entries
    console.log(`\n[${cred.name}]`);
    await ensureServicesForAgent(slug, cred.id, cred.key);
  }

  // Also ensure original SELLER services if using default config
  if (agentCredentials['_default'] && !Object.keys(agentCredentials).some(k => !k.startsWith('_'))) {
    console.log('\n[Default Seller — legacy services]');
    // The original 4 services are kept for backward compatibility
  }

  // Start polling for orders
  console.log('\n--- Starting order fulfillment loop ---');
  console.log(`Polling every ${POLL_INTERVAL / 1000}s for ${Object.keys(agentCredentials).length} agent(s)...`);
  console.log('');

  pollAllOrders();
  setInterval(pollAllOrders, POLL_INTERVAL);
}

main().catch(console.error);
