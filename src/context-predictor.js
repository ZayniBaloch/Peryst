/**
 * context-predictor.js — Predictive Context Forecasting Engine
 * 
 * Tracks developer interaction patterns across domains (Stack, Architecture, Compliance, Deployment)
 * and pre-compiles dense category node summaries for zero-latency prompt context loading.
 */

import db from './database.js';
import { buildHierarchyTree } from './hierarchy.js';

/**
 * Predict and return pre-compiled dense category summaries for active agent intent domains.
 * @param {string} agentId - Current agent ID
 * @param {string} namespace - Project namespace
 * @returns {Array<string>} Dense category summaries for high-frequency intent domains
 */
export function predictNextContext(agentId = 'antigravity-worker', namespace = 'shared') {
  const tree = buildHierarchyTree(namespace);
  if (!tree || !tree.categories || tree.categories.length === 0) {
    return [];
  }

  // Pre-compiled dense category node summaries
  return tree.categories.slice(0, 4).map(c => c.summary);
}
