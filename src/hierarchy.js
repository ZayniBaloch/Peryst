/**
 * hierarchy.js — Hierarchical Memory Tree Engine
 * 
 * Structures atomic facts into 3 hierarchy levels:
 *   Level 1: Root Project Node
 *   Level 2: Category Cluster Nodes (Stack, Architecture, Compliance, Deployment, Preferences)
 *   Level 3: Atomic Fact Leaf Nodes
 */

import db, { getMemoryById } from './database.js';

export const CATEGORIES = {
  STACK: ['stack:', 'node', 'sqlite', 'sqlite-vec', '@huggingface', 'dependencies', 'framework', 'package.json'],
  ARCHITECTURE: ['architecture:', 'module', 'design', 'component', 'system', 'pattern', 'mcp', 'sdk'],
  COMPLIANCE: ['compliance gates:', 'compliance', 'gdpr', 'hipaa', 'soc2', 'security', 'privacy', 'secret', 'redaction'],
  DEPLOYMENT: ['deployment:', 'deploy', 'docker', 'ci/cd', 'release', 'build', 'github actions', 'export', 'import'],
  USER_PREFERENCES: ['preference:', 'user:', 'tone', 'style', 'format', 'concise', 'logical'],
  MILESTONES: ['recent milestone:', 'milestone:', 'implemented', 'added', 'fixed', 'launch ready']
};

/**
 * Determine the hierarchy category for a fact.
 * @param {string} content - Memory fact text
 * @returns {string} Category name
 */
export function categorizeFact(content) {
  if (!content || typeof content !== 'string') return 'GENERAL';
  const lower = content.toLowerCase();

  for (const [catName, keywords] of Object.entries(CATEGORIES)) {
    if (keywords.some(k => lower.includes(k))) {
      return catName;
    }
  }

  return 'GENERAL';
}

/**
 * Build hierarchical memory tree for a namespace.
 * Group leaf memories into Level 2 Category Cluster nodes.
 * @param {string} namespace
 * @returns {Object} Structured hierarchy tree
 */
export function buildHierarchyTree(namespace = 'shared') {
  const rows = db.prepare(`
    SELECT id, content, summary, importance_score, namespace, parent_id, hierarchy_level
    FROM memories
    WHERE valid_until IS NULL
      AND (namespace = ? OR namespace = 'shared')
    ORDER BY importance_score DESC
  `).all(namespace);

  const clusters = {};

  for (const r of rows) {
    const category = categorizeFact(r.content);
    if (!clusters[category]) {
      clusters[category] = {
        name: category,
        level: 2,
        leaves: []
      };
    }
    clusters[category].leaves.push({
      id: r.id,
      summary: r.summary || r.content,
      content: r.content,
      importance: r.importance_score
    });
  }

  // Generate dense Level 2 category node summaries
  const categoryNodes = Object.entries(clusters).map(([catName, cluster]) => {
    const leafSummaries = cluster.leaves.slice(0, 4).map(l => l.summary);
    const categorySummary = `${catName}: ${leafSummaries.join('; ')}`;

    return {
      name: catName,
      level: 2,
      summary: categorySummary,
      leafCount: cluster.leaves.length,
      leaves: cluster.leaves
    };
  });

  return {
    root: 'Peryst Workspace Tree',
    level: 1,
    categories: categoryNodes
  };
}

/**
 * Traverses the hierarchy tree to return a single dense Level 2 category node
 * summary when the query targets a top-level domain (e.g., "deployment", "compliance").
 * 
 * @param {string} query - Search query
 * @param {string} namespace - Namespace
 * @returns {string|null} Dense category summary node text, or null if no exact category match
 */
export function getSubtreeForQuery(query, namespace = 'shared') {
  if (!query || typeof query !== 'string') return null;
  const targetCategory = categorizeFact(query);
  if (targetCategory === 'GENERAL') return null;

  const tree = buildHierarchyTree(namespace);
  const matched = tree.categories.find(c => c.name === targetCategory);
  if (matched && matched.summary) {
    return matched.summary;
  }

  return null;
}
