'use strict';

const crypto = require('crypto');

const SCHEMA_VERSION = 1;
const COLLECTOR_VERSION = '1.0.0';

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

/** Deterministic event id from the event type and its natural key. */
function eventId(type, naturalKey) {
  return `evt_${sha256(`${type}|${naturalKey}`).slice(0, 24)}`;
}

/** JSON.stringify with sorted object keys, so identical data serializes identically. */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

// Patterns for values that must never reach the history: tokens, keys,
// passwords and credentials embedded in URLs or error messages.
const SECRET_PATTERNS = [
  [/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_KEY]'],
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 [REDACTED]'],
  [/\b(password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)(["']?\s*[:=]\s*["']?)(?!\[REDACTED)[^\s"',;&]+/gi, '$1$2[REDACTED]'],
  [/([?&](?:token|key|sig|signature|password|secret|code)=)(?!\[REDACTED)[^&\s"']+/gi, '$1[REDACTED]'],
  [/(\/\/)(?!\[REDACTED)[^/\s:@]+:[^/\s@]+@/g, '$1[REDACTED]@'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_JWT]'],
];

/** Removes ANSI colours and secrets, collapses whitespace runs and truncates. */
function sanitizeText(text, maxLength = 600) {
  if (text === undefined || text === null) return text;
  let out = String(text).replace(ANSI, '');
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  out = out.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return out.length > maxLength ? `${out.slice(0, maxLength - 1)}…` : out;
}

/** Recursively sanitizes every string inside a value. */
function sanitizeDeep(value, maxLength) {
  if (typeof value === 'string') return sanitizeText(value, maxLength);
  if (Array.isArray(value)) return value.map((v) => sanitizeDeep(v, maxLength));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeDeep(v, maxLength);
    return out;
  }
  return value;
}

/** Returns true if the text still contains something that looks like a secret. */
function containsSecret(text) {
  return SECRET_PATTERNS.some(([pattern]) => {
    pattern.lastIndex = 0;
    const hit = pattern.test(String(text));
    pattern.lastIndex = 0;
    return hit;
  });
}

function uniq(values) {
  return [...new Set(values)];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  SCHEMA_VERSION,
  COLLECTOR_VERSION,
  sha256,
  eventId,
  stableStringify,
  sanitizeText,
  sanitizeDeep,
  containsSecret,
  uniq,
  sleep,
};
