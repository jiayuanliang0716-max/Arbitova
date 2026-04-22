#!/usr/bin/env node
// Smoke test: spawn the MCP server, send ListTools + ListResources, assert shape.
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const env = {
  ...process.env,
  ARBITOVA_RPC_URL: 'https://sepolia.base.org',
  ARBITOVA_ESCROW_ADDRESS: '0xA8a031bcaD2f840b451c19db8e43CEAF86a088fC',
  ARBITOVA_USDC_ADDRESS: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  // No ARBITOVA_AGENT_PRIVATE_KEY — test read-only mode
};

const child = spawn('node', [path.join(__dirname, 'index.js')], {
  env,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stdoutBuf = '';
child.stdout.on('data', (d) => { stdoutBuf += d.toString(); });
child.stderr.on('data', (d) => process.stderr.write(`[server stderr] ${d}`));

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + '\n');
}

function readOne() {
  return new Promise((resolve) => {
    const check = () => {
      const nl = stdoutBuf.indexOf('\n');
      if (nl === -1) return setTimeout(check, 50);
      const line = stdoutBuf.slice(0, nl);
      stdoutBuf = stdoutBuf.slice(nl + 1);
      resolve(JSON.parse(line));
    };
    check();
  });
}

(async () => {
  let failures = 0;
  const fail = (msg) => { console.error('FAIL:', msg); failures++; };
  const pass = (msg) => console.log('PASS:', msg);

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-test', version: '1.0' },
  }});
  const initRes = await readOne();
  if (initRes.result?.serverInfo?.version === '4.0.0') pass('initialize -> v4.0.0');
  else fail(`initialize unexpected: ${JSON.stringify(initRes)}`);

  send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

  send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  const toolsRes = await readOne();
  const tools = toolsRes.result?.tools || [];
  if (tools.length === 6) pass(`tools/list returned 6 tools`);
  else fail(`expected 6 tools, got ${tools.length}`);

  const expectedNames = [
    'arbitova_create_escrow',
    'arbitova_mark_delivered',
    'arbitova_confirm_delivery',
    'arbitova_dispute',
    'arbitova_get_escrow',
    'arbitova_cancel_if_not_delivered',
  ];
  const names = tools.map((t) => t.name).sort();
  const expSorted = [...expectedNames].sort();
  if (JSON.stringify(names) === JSON.stringify(expSorted)) pass('tool names match spec');
  else fail(`tool name mismatch: ${names.join(',')} vs ${expSorted.join(',')}`);

  // Every tool should have a description > 100 chars (Path B safety policy text)
  for (const t of tools) {
    if (t.description && t.description.length > 100) continue;
    fail(`tool ${t.name} description too short: ${t.description?.length || 0} chars`);
  }
  if (failures === 0) pass('all tool descriptions >= 100 chars');

  // Descriptions must not mention Path A / API key / a2a-system.onrender.com
  const badRegex = /(api[ -]key|onrender\.com|PENDING|CONFIRMED)/i;
  for (const t of tools) {
    if (badRegex.test(t.description)) fail(`tool ${t.name} description contains Path A reference: ${t.description}`);
  }

  send({ jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} });
  const resRes = await readOne();
  const resources = resRes.result?.resources || [];
  if (resources.length === 4) pass('resources/list returned 4 resources');
  else fail(`expected 4 resources, got ${resources.length}`);

  // Read ABI resource — verify it's JSON and contains getEscrow
  send({ jsonrpc: '2.0', id: 4, method: 'resources/read', params: { uri: 'arbitova://resources/escrow-abi' }});
  const abiRes = await readOne();
  const abiText = abiRes.result?.contents?.[0]?.text || '';
  if (abiText.includes('getEscrow') && abiText.includes('createEscrow')) pass('escrow ABI resource includes getEscrow + createEscrow');
  else fail('escrow ABI resource missing expected entries');

  // Call a write tool in read-only mode — should error politely
  send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: {
    name: 'arbitova_create_escrow',
    arguments: { seller: '0x0000000000000000000000000000000000000001', amount: 1, verificationURI: 'https://example.com/x.json' },
  }});
  const writeRes = await readOne();
  const writeText = writeRes.result?.content?.[0]?.text || '';
  if (/ARBITOVA_AGENT_PRIVATE_KEY/.test(writeText)) pass('read-only mode rejects write with clear hint');
  else fail(`expected read-only rejection, got: ${writeText}`);

  // Read tool should work (will fail on actual RPC call but shape should be { ok: false, error, ... })
  send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: {
    name: 'arbitova_get_escrow',
    arguments: { escrowId: '1' },
  }});
  const readRes = await readOne();
  const readText = readRes.result?.content?.[0]?.text || '';
  try {
    const parsed = JSON.parse(readText);
    if (parsed.ok === true && parsed.buyer) pass('get_escrow succeeded against real Base Sepolia');
    else if (parsed.ok === false) pass(`get_escrow returned structured error (expected if escrow 1 not on chain or RPC down)`);
    else fail(`get_escrow unexpected shape: ${readText}`);
  } catch {
    fail(`get_escrow returned non-JSON: ${readText}`);
  }

  child.kill();

  console.log(`\n${failures === 0 ? 'ALL GOOD' : failures + ' FAILURES'}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.error('smoke-test crashed:', e);
  child.kill();
  process.exit(2);
});
