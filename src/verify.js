/**
 * Structured contract verification helpers.
 *
 * Services may declare:
 *   - input_schema:  JSON Schema the buyer's `requirements` (parsed as JSON) must satisfy
 *   - output_schema: JSON Schema the seller's delivery `content` (parsed as JSON) must satisfy
 *   - verification_rules: array of simple rules run against delivery content
 *   - auto_verify: boolean — if true and all checks pass, delivery auto-completes
 *
 * Rule types (all operate on a dotted path inside the parsed content):
 *   { "type": "required",   "path": "summary" }
 *   { "type": "min_length", "path": "summary", "value": 100 }
 *   { "type": "max_length", "path": "summary", "value": 5000 }
 *   { "type": "contains",   "path": "summary", "value": "conclusion", "ignore_case": true }
 *   { "type": "regex",      "path": "summary", "value": "\\d{4}" }
 *   { "type": "equals",     "path": "status",  "value": "ok" }
 *   { "type": "min_items",  "path": "tags",    "value": 3 }
 */

const Ajv = require('ajv');
const ajv = new Ajv({ allErrors: true, strict: false });

function parseMaybeJson(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}

function parseSchemaField(s) {
  if (s == null) return null;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * Validate a value against a JSON Schema. Returns { ok, errors }.
 */
function validateAgainstSchema(schema, value) {
  if (!schema) return { ok: true, errors: [] };
  try {
    const validate = ajv.compile(schema);
    const ok = validate(value);
    return { ok: !!ok, errors: ok ? [] : (validate.errors || []).map(e => `${e.instancePath || '/'} ${e.message}`) };
  } catch (e) {
    return { ok: false, errors: ['Schema compile error: ' + e.message] };
  }
}

function getPath(obj, path) {
  if (!path) return obj;
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

/**
 * Run an array of verification rules against a parsed content object.
 * Returns { ok, failures }.
 */
function runRules(rules, content) {
  if (!rules || !Array.isArray(rules) || rules.length === 0) return { ok: true, failures: [] };
  const failures = [];
  for (const rule of rules) {
    const v = getPath(content, rule.path);
    switch (rule.type) {
      case 'required':
        if (v == null || v === '') failures.push(`required: ${rule.path} missing`);
        break;
      case 'min_length':
        if (typeof v !== 'string' || v.length < rule.value) failures.push(`min_length: ${rule.path} must be ≥${rule.value}`);
        break;
      case 'max_length':
        if (typeof v === 'string' && v.length > rule.value) failures.push(`max_length: ${rule.path} must be ≤${rule.value}`);
        break;
      case 'contains': {
        if (typeof v !== 'string') { failures.push(`contains: ${rule.path} not a string`); break; }
        const hay = rule.ignore_case ? v.toLowerCase() : v;
        const needle = rule.ignore_case ? String(rule.value).toLowerCase() : String(rule.value);
        if (!hay.includes(needle)) failures.push(`contains: ${rule.path} must contain "${rule.value}"`);
        break;
      }
      case 'regex':
        if (typeof v !== 'string' || !(new RegExp(rule.value).test(v))) failures.push(`regex: ${rule.path} must match /${rule.value}/`);
        break;
      case 'equals':
        if (v !== rule.value) failures.push(`equals: ${rule.path} must equal ${JSON.stringify(rule.value)}`);
        break;
      case 'min_items':
        if (!Array.isArray(v) || v.length < rule.value) failures.push(`min_items: ${rule.path} must have ≥${rule.value} items`);
        break;
      default:
        failures.push(`unknown rule type: ${rule.type}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * Verify a delivery against a service's contract.
 * Returns { ok, stage, errors } where stage is 'output_schema' | 'rules' | null.
 */
function verifyDelivery(service, deliveryContent) {
  const outSchema = parseSchemaField(service.output_schema);
  const rules = parseSchemaField(service.verification_rules);
  const parsed = parseMaybeJson(deliveryContent);

  if (outSchema) {
    if (parsed === null) return { ok: false, stage: 'output_schema', errors: ['Delivery content is not valid JSON'] };
    const r = validateAgainstSchema(outSchema, parsed);
    if (!r.ok) return { ok: false, stage: 'output_schema', errors: r.errors };
  }
  if (rules && Array.isArray(rules) && rules.length > 0) {
    if (parsed === null) return { ok: false, stage: 'rules', errors: ['Delivery content is not valid JSON'] };
    const r = runRules(rules, parsed);
    if (!r.ok) return { ok: false, stage: 'rules', errors: r.failures };
  }
  return { ok: true, stage: null, errors: [] };
}

/**
 * Verify a buyer's `requirements` against a service's input schema.
 */
function verifyInput(service, requirements) {
  const inSchema = parseSchemaField(service.input_schema);
  if (!inSchema) return { ok: true, errors: [] };
  const parsed = parseMaybeJson(requirements);
  if (parsed === null) return { ok: false, errors: ['Requirements must be valid JSON matching input_schema'] };
  return validateAgainstSchema(inSchema, parsed);
}

/**
 * Semantic verification using Claude.
 *
 * Called after structural checks pass, when service.semantic_verify = true.
 * Asks Claude: "Does this delivery actually fulfill the requirements?"
 *
 * Returns { ok, score, reasoning }
 *   ok    — true if score >= threshold (default 0.7)
 *   score — 0.0–1.0 fulfillment score
 */
async function verifyDeliverySemantic(service, deliveryContent, requirements) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { ok: true, score: 1.0, reasoning: 'Semantic verification skipped (no API key)' };
  }

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const deliveryStr = typeof deliveryContent === 'string'
      ? deliveryContent.slice(0, 3000)
      : JSON.stringify(deliveryContent).slice(0, 3000);

    const prompt = `You are a delivery quality reviewer for an AI agent marketplace.

## Service
Name: ${service.name || 'Unknown'}
Description: ${service.description || 'N/A'}

## Buyer Requirements
${requirements || 'None specified'}

## Delivery Content
${deliveryStr}

## Task
Score how well this delivery fulfills the buyer's requirements.
Respond ONLY in this JSON (no markdown):
{"score": <0.0-1.0>, "reasoning": "<1-2 sentences>", "fulfilled": <true|false>}

score: 1.0 = perfectly fulfilled, 0.0 = completely irrelevant.
fulfilled: true if score >= 0.7.`;

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      messages: [{ role: 'user', content: prompt }],
    });

    const result = JSON.parse(msg.content[0].text.trim());
    const score = parseFloat(result.score) || 0;
    return {
      ok: score >= 0.7,
      score,
      reasoning: result.reasoning || '',
    };
  } catch (err) {
    // Semantic check failure is non-fatal — fall back to structural check result
    return { ok: true, score: 1.0, reasoning: `Semantic check error (ignored): ${err.message}` };
  }
}

module.exports = { verifyDelivery, verifyInput, validateAgainstSchema, runRules, parseMaybeJson, parseSchemaField, verifyDeliverySemantic };
