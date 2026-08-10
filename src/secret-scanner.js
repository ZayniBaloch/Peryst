/**
 * ScopeKeep — Secret and PII Scanner
 *
 * Scans text content for sensitive patterns (API keys, credentials, private keys, tokens, emails)
 * before durable memory storage to enforce GDPR and security controls.
 */

const SECRET_PATTERNS = [
  { name: 'AWS Access Key ID', regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g, redact: '[REDACTED_AWS_KEY]' },
  { name: 'AWS Secret Key', regex: /\b[0-9a-zA-Z/+=]{40}\b(?=.*[A-Za-z])(?=.*[0-9])/g, redact: '[REDACTED_AWS_SECRET]' },
  { name: 'GitHub Personal Access Token', regex: /\bgh[pousr]_[A-Za-z0-9_]{36,255}\b/g, redact: '[REDACTED_GITHUB_TOKEN]' },
  { name: 'Generic API Key / Bearer', regex: /\b(api[_-]?key|bearer[_-]?token|secret[_-]?key)\s*[:=]\s*['"]?([a-zA-Z0-9_\-\.]{16,128})['"]?/gi, redact: '$1: "[REDACTED_SECRET]"' },
  { name: 'Private Key', regex: /-----BEGIN\s+(RSA|EC|OPENSSH|DSA|PRIVATE)\s+KEY-----[\s\S]*?-----END\s+(RSA|EC|OPENSSH|DSA|PRIVATE)\s+KEY-----/gi, redact: '[REDACTED_PRIVATE_KEY]' },
  { name: 'JWT Token', regex: /\bey[A-Za-z0-9_-]{10,}\.ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, redact: '[REDACTED_JWT_TOKEN]' },
  { name: 'Email Address', regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, redact: '[REDACTED_EMAIL]' }
];

/**
 * Scan text for secrets or PII.
 * @param {string} text
 * @returns {{ hasSecrets: boolean, findings: string[], sanitizedText: string }}
 */
export function scanAndSanitize(text) {
  if (!text || typeof text !== 'string') {
    return { hasSecrets: false, findings: [], sanitizedText: text || '' };
  }

  let sanitizedText = text;
  const findings = [];

  for (const pattern of SECRET_PATTERNS) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(text)) {
      findings.push(pattern.name);
      sanitizedText = sanitizedText.replace(pattern.regex, pattern.redact);
    }
  }

  return {
    hasSecrets: findings.length > 0,
    findings,
    sanitizedText
  };
}
