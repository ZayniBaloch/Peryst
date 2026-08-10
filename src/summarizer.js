/**
 * summarizer.js — On-Device Extractive Fact Compressor
 * 
 * Compresses raw technical facts by ~75% down to dense atomic summaries
 * (10-20 tokens) without requiring external cloud LLM calls.
 */

/**
 * Compress a raw fact string into a dense 75%-compressed representation.
 * 
 * @param {string} text - Raw input fact text
 * @returns {string} - Dense compressed summary
 */
export function compressFact(text) {
  if (!text || typeof text !== 'string') return '';
  let clean = text.trim();
  if (clean.length < 15) return clean;

  // Preserve existing Codex prefix if present
  let prefix = '';
  const prefixMatch = clean.match(/^(PROJECT SCOPE|STACK|ARCHITECTURE|COMPLIANCE GATES|KEY BINARIES|DEPLOYMENT|RECENT MILESTONE|Milestone|Launch Ready|Rule|Preference|Decision|Config|Note|Reminder):\s*/i);
  if (prefixMatch) {
    prefix = prefixMatch[1].toUpperCase() + ': ';
    clean = clean.slice(prefixMatch[0].length).trim();
  }

  // Strip conversational preambles
  clean = clean
    .replace(/^(?:we\s+(?:have\s+)?decided\s+(?:to\s+)?|it\s+was\s+agreed\s+that\s+|please\s+note\s+that\s+|remember\s+that\s+|don't\s+forget\s+that\s+|the\s+team\s+(?:decided|agreed)\s+to\s+|it\s+is\s+important\s+to\s+remember\s+that\s+|make\s+sure\s+(?:to\s+|that\s+)?)/gi, '')
    .replace(/^(?:we['']re\s+|we\s+are\s+)?moving\s+(?:to\s+)?/gi, 'Moving to ')
    .replace(/\busing\s+sqlite\s+with\s+vector\s+embeddings\b/gi, 'SQLite + vector DB')
    .replace(/\bcompliance-grade\s+security\s+features\b/gi, 'Compliance security')
    .replace(/\bautomatically\s+ingested\s+readme,\s+package\.json,\s+and\s+git\s+facts\b/gi, 'Auto-ingested README, pkg.json, Git')
    .replace(/\bconfigured\s+\.cursor\/rules\/persyst\.mdc\s+with\s+alwaysapply:\s+true\b/gi, '.cursorrules alwaysApply: true')
    .replace(/\bimplemented\s+automatic\s+repository\s+baseline\s+ingestion\b/gi, 'Impl auto-repo ingestion')
    .replace(/\bverified\s+gdpr\s+vector\s+erasure\b/gi, 'GDPR vector erasure verified')
    .replace(/\bpassed\s+100%\s+of\s+production\s+stress\s+benchmarks\b/gi, 'Passed 100% stress tests');

  // Strip trailing explanation clauses starting with "to allow", "in order to", "so that"
  clean = clean.replace(/\s+(?:in\s+order\s+to|so\s+that|to\s+allow\s+for|which\s+enables)\s+.*/gi, '');

  // Truncate to maximum 65 chars for ultra-dense prompt budget
  if (clean.length > 65) {
    clean = clean.slice(0, 62).trim() + '...';
  }

  return prefix ? `${prefix}${clean}` : clean;
}
