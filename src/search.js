/**
 * search.js — Hybrid Search & Context Optimization Engine
 * 
 * Combines keyword and semantic searches, integrates temporal decay,
 * applies agent reputation scores, generates cryptographic search attestations,
 * builds graph-hopped optimized LLM context prompts, and applies MMR
 * for diverse result retrieval.
 */

import db, {
  stmts,
  searchKeyword,
  searchVector,
  getMemoryById,
  boostMemory,
  getProvenance,
  getMemoriesByEntity,
  getAllEntities,
  WORKSPACE_ID
} from './database.js';
import { generateEmbedding } from './embeddings.js';
import { createAttestation } from './attestation.js';
import { searchCache, LRUCache } from './cache.js';
import { jaccardSimilarity, logInfo } from './text-utils.js';

let lastDataVersion = 0;

/**
 * Search memories using both keyword and semantic strategies.
 * Results are cached in the LRU cache for repeated queries.
 * 
 * @param {string} queryText - What to search for
 * @param {number} limit - Max results to return (default: 5)
 * @param {string|null} agentId - Identifying string for the querying agent
 * @param {string|null} sessionId - Session identifier
 * @returns {Promise<Array>} Ranked search results (with .attestation property attached)
 */
export async function searchHybrid(queryText, limit = 5, agentId = null, sessionId = null, namespace = null, skipAttestation = false) {
  if (typeof limit !== 'number' || isNaN(limit) || limit <= 0) {
    throw new Error('Limit must be a positive integer.');
  }
  const parsedLimit = Math.floor(limit);
  const ns = namespace || 'shared';

  // Sync in-memory cache with external DB changes using sqlite data_version
  try {
    const currentDataVersion = db.pragma('data_version', { simple: true });
    if (currentDataVersion !== lastDataVersion) {
      searchCache.invalidate();
      lastDataVersion = currentDataVersion;
    }
  } catch (_) {
    // Fallback if pragma fails
  }

  // --- Check LRU cache first (Feature 1) ---
  // Include namespace in cache key to prevent cross-namespace cache hits
  const cacheKey = LRUCache.key(`${ns}:${queryText}`, parsedLimit);
  const cached = searchCache.get(cacheKey);
  if (cached) {
    logInfo(`[scopekeep-cache] Cache HIT for query: "${queryText.slice(0, 50)}..."`);
    return cached;
  }

  // --- Step 1: Keyword search (fast, exact matches) ---
  const keywordHits = searchKeyword(queryText, parsedLimit * 2, ns);
  const keywordIds = new Set(keywordHits.map(r => r.id));

  // --- Step 2: Semantic search (meaning-based) ---
  const queryEmbedding = await generateEmbedding(queryText);
  const vecHits = searchVector(queryEmbedding, parsedLimit * 2, ns);

  const semanticResults = vecHits.map(r => ({
    id: Number(r.rowid),
    distance: r.distance,
    // Convert L2 distance to 0-1 similarity score
    similarity: Math.max(0, 1 - (r.distance * r.distance) / 2)
  }));

  // --- Step 3: Merge results with keyword boost ---
  const combined = semanticResults
    .map(r => {
      const isKeywordMatch = keywordIds.has(r.id);
      return {
        id: r.id,
        similarity: r.similarity,
        hybrid_score: r.similarity + (isKeywordMatch ? 0.2 : 0),
        keyword_match: isKeywordMatch
      };
    })
    // Filter out low similarity semantic matches if they have no keyword match (threshold 0.30)
    .filter(r => r.keyword_match || r.similarity >= 0.30);

  // Add keyword-only hits that semantic search missed
  const semanticIds = new Set(semanticResults.map(r => r.id));
  for (const id of keywordIds) {
    if (!semanticIds.has(id)) {
      combined.push({
        id,
        similarity: 0,
        hybrid_score: 0.2,  // Keyword-only base score
        keyword_match: true
      });
    }
  }

  // --- Step 4: Fetch full details, apply namespace filter, reputation adjust, sort and return top N ---
  const finalResults = combined
    .map(r => {
      // Use namespace-aware getMemoryById to filter by agent namespace
      const memory = getMemoryById(r.id, ns);
      if (!memory) return null; // Memory was archived, deleted, or not in namespace

      // Boost memory access metrics
      boostMemory(r.id);

      // Fetch reputation stats for weighting
      let reputationScore = 1.0;
      let reputationWarning = false;
      const prov = memory.provenance;
      if (prov && prov.source_type === 'agent' && prov.source_id) {
        const agentRow = stmts.getReputationScore.get(prov.source_id, WORKSPACE_ID);
        if (agentRow) {
          reputationScore = agentRow.reputation_score;
          if (reputationScore < 0.5) {
            reputationWarning = true;
          }
        }
      }

      // Final score formula: base_score * agent_reputation
      const finalScore = r.hybrid_score * reputationScore;

      return {
        id: memory.id,
        content: memory.content,
        summary: memory.summary || memory.content,
        importance_score: memory.importance_score,
        created_at: memory.created_at,
        last_accessed: memory.last_accessed,
        similarity: Math.round(r.similarity * 10000) / 10000,
        hybrid_score: Math.round(finalScore * 10000) / 10000,
        keyword_match: r.keyword_match,
        reputation_warning: reputationWarning,
        provenance: prov
      };
    })
    .filter(Boolean);

  // Sort by final score descending
  finalResults.sort((a, b) => parseFloat(b.hybrid_score) - parseFloat(a.hybrid_score));

  // --- Step 4.5: Query-Time Distinct Semantic Pruning ---
  const prunedResults = pruneRedundantHits(finalResults, 0.70);

  // --- Step 5: Apply MMR for diverse retrieval (Feature 3) ---
  const mmrResults = applyMMR(prunedResults, parsedLimit);

  // Generate cryptographic attestation for audit trails (skip if called internally)
  let attestation = null;
  if (!skipAttestation) {
    attestation = createAttestation(queryText, mmrResults, agentId, sessionId);
    mmrResults.attestation = attestation;
  }

  // --- Store in LRU cache (Feature 1) ---
  searchCache.set(cacheKey, mmrResults);

  return mmrResults;
}

/**
 * Prune redundant candidate search hits using string / semantic similarity overlap threshold.
 * @param {Array} items
 * @param {number} threshold - Jaccard similarity threshold (default: 0.70)
 * @returns {Array} Pruned items
 */
function pruneRedundantHits(items, threshold = 0.70) {
  const pruned = [];
  for (const item of items) {
    const textA = (item.summary || item.content).toLowerCase();
    let isDuplicate = false;
    for (const kept of pruned) {
      const textB = (kept.summary || kept.content).toLowerCase();
      const wordsA = new Set(textA.split(/\s+/));
      const wordsB = new Set(textB.split(/\s+/));
      let intersection = 0;
      for (const w of wordsA) if (wordsB.has(w)) intersection++;
      const union = wordsA.size + wordsB.size - intersection;
      const jaccardSim = union > 0 ? (intersection / union) : 0;
      if (jaccardSim >= threshold) {
        isDuplicate = true;
        break;
      }
    }
    if (!isDuplicate) {
      pruned.push(item);
    }
  }
  return pruned;
}

/**
 * Apply Maximal Marginal Relevance (MMR) re-ranking for diverse results.
 * 
 * MMR balances relevance with diversity by penalizing candidates that
 * are too similar to already-selected results.
 * 
 * @param {Array} candidates - Scored search results
 * @param {number} limit - Max results to return
 * @param {number} lambda - Trade-off parameter (0.7 = 70% relevance, 30% diversity)
 * @returns {Array} MMR-reranked results
 */
function applyMMR(candidates, limit, lambda = 0.7) {
  if (candidates.length <= limit) return candidates;

  const selected = [];
  const remaining = [...candidates];

  // Always pick the top-scored result first
  selected.push(remaining.shift());

  while (selected.length < limit && remaining.length > 0) {
    let bestIdx = -1;
    let bestMMRScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const relevance = parseFloat(candidate.hybrid_score);

      // Calculate max similarity to any already-selected result
      // Using content-based Jaccard similarity as a proxy
      let maxSimToSelected = 0;
      for (const sel of selected) {
        const sim = jaccardSimilarity(candidate.content, sel.content);
        if (sim > maxSimToSelected) maxSimToSelected = sim;
      }

      // MMR score = λ * relevance - (1 - λ) * max_similarity_to_selected
      const mmrScore = lambda * relevance - (1 - lambda) * maxSimToSelected;

      if (mmrScore > bestMMRScore) {
        bestMMRScore = mmrScore;
        bestIdx = i;
      }
    }

    if (bestIdx >= 0) {
      selected.push(remaining.splice(bestIdx, 1)[0]);
    } else {
      break;
    }
  }

  return selected;
}

/**
 * Optimizes the retrieved context by walking the knowledge graph and compressing content to fit max_tokens.
 * 
 * @param {string} queryText - User's query
 * @param {number} maxTokens - Hard limit of tokens for context prompt
 * @param {string|null} agentId - Querying agent identifier
 * @param {string|null} sessionId - Current session ID
 */
export async function getOptimizedContext(queryText, maxTokens, agentId = null, sessionId = null, namespace = null, intentParam = null) {
  // Classify intent and urgency early to adjust token budget dynamically
  const { intent, urgency } = classifyIntentAndUrgency(queryText, intentParam);
  let targetMaxTokens = maxTokens;
  if (intent === 'general' || intent === 'testing') {
    targetMaxTokens = Math.min(maxTokens, 1500);
  }

  // Extract entities mentioned in the query text to seed the graph search directly
  const entities = getAllEntities(100);
  const matchedEntityIds = new Set();
  for (const ent of entities) {
    const entNameLower = ent.name.toLowerCase();
    if (queryText.toLowerCase().includes(entNameLower)) {
      matchedEntityIds.add(ent.id);
    }
  }

  // 1. Run hybrid search to fetch top 20 memories as seeds (skip attestation to avoid double-write)
  const searchHits = await searchHybrid(queryText, 20, agentId, sessionId, namespace, true);
  const candidates = new Map();

  for (const hit of searchHits) {
    candidates.set(hit.id, {
      id: hit.id,
      content: hit.content,
      importance_score: hit.importance_score,
      created_at: hit.created_at,
      last_accessed: hit.last_accessed,
      score: parseFloat(hit.hybrid_score),
      provenance: hit.provenance,
      source: 'search'
    });
  }

  // 2. Perform Graph Hop (multi-hop traversal) globally
  const hopQueue = [];
  const visitedNodes = new Set(); // Stores "type:id" keys

  // Seed with matched entities from query text
  for (const entId of matchedEntityIds) {
    const key = `entity:${entId}`;
    if (!visitedNodes.has(key)) {
      visitedNodes.add(key);
      hopQueue.push({ id: entId, type: 'entity', depth: 0 });
    }
  }

  // Seed with search hit memories
  for (const hit of searchHits) {
    const key = `memory:${hit.id}`;
    if (!visitedNodes.has(key)) {
      visitedNodes.add(key);
      hopQueue.push({ id: hit.id, type: 'memory', depth: 0 });
    }
  }

  // BFS to traverse memories and entities uniformly up to depth 6
  while (hopQueue.length > 0) {
    const { id, type, depth } = hopQueue.shift();
    if (depth >= 6) continue;

    // --- 2a. Explicit Graph Edges (from edges table) ---
    const connectedEdges = stmts.getEdgesBySourceAndType.all(WORKSPACE_ID, id, type, id, type);

    for (const edge of connectedEdges) {
      let nextId, nextType;
      if (edge.source_id === id && edge.source_type === type) {
        nextId = edge.target_id;
        nextType = edge.target_type;
      } else {
        nextId = edge.source_id;
        nextType = edge.source_type;
      }

      const key = `${nextType}:${nextId}`;
      if (!visitedNodes.has(key)) {
        visitedNodes.add(key);
        hopQueue.push({ id: nextId, type: nextType, depth: depth + 1 });
      }
    }

    // --- 2b. Implicit Name-Based Edges (for robustness when explicit edges are missing) ---
    if (type === 'memory') {
      const memoryRow = stmts.getMemoryContentById.get(id, WORKSPACE_ID);
      if (memoryRow && memoryRow.content) {
        const contentLower = memoryRow.content.toLowerCase();
        for (const ent of entities) {
          if (contentLower.includes(ent.name.toLowerCase())) {
            const nextKey = `entity:${ent.id}`;
            if (!visitedNodes.has(nextKey)) {
              visitedNodes.add(nextKey);
              hopQueue.push({ id: ent.id, type: 'entity', depth: depth + 1 });
            }
          }
        }
      }
    } else if (type === 'entity') {
      const ent = entities.find(e => e.id === id);
      if (ent && ent.name) {
        const matchingMemories = stmts.getMemoryLikeContent.all(`%${ent.name}%`, WORKSPACE_ID);
        for (const row of matchingMemories) {
          const nextKey = `memory:${row.id}`;
          if (!visitedNodes.has(nextKey)) {
            visitedNodes.add(nextKey);
            hopQueue.push({ id: row.id, type: 'memory', depth: depth + 1 });
          }
        }
      }
    }
  }

  // Now collect all hopped memories from the visited nodes
  for (const key of visitedNodes) {
    const [type, idStr] = key.split(':');
    if (type === 'memory') {
      const memId = Number(idStr);
      if (candidates.has(memId)) continue; // Keep search hit info

      // Check namespace filter if present
      const other = getMemoryById(memId, namespace);
      if (!other) continue;

      let baseScore = 0.4;
      if (searchHits.length > 0) {
        const maxSearchScore = Math.max(...searchHits.map(h => parseFloat(h.hybrid_score)));
        baseScore = maxSearchScore * 0.5;
      }

      const otherProv = getProvenance(memId);
      candidates.set(memId, {
        id: other.id,
        content: other.content,
        importance_score: other.importance_score,
        created_at: other.created_at,
        last_accessed: other.last_accessed,
        score: baseScore,
        provenance: otherProv,
        source: 'hop'
      });
    }
  }

  // 3. Apply Scoring Adjustments
  const now = Math.floor(Date.now() / 1000);
  const list = Array.from(candidates.values());

  for (const c of list) {
    // 3a. Temporal decay: score *= exp(-0.01 * hours_since_accessed)
    const hours = Math.max(0, (now - c.last_accessed) / 3600);
    c.score *= Math.exp(-0.01 * hours);

    // 3b. Agent reputation weighting
    let reputationScore = 1.0;
    if (c.provenance && c.provenance.source_type === 'agent' && c.provenance.source_id) {
      const agentRow = db.prepare('SELECT reputation_score FROM agent_stats WHERE agent_id = ?').get(c.provenance.source_id);
      if (agentRow) {
        reputationScore = agentRow.reputation_score;
      }
    }
    c.score *= reputationScore;
  }

  // 4. Sort candidates
  list.sort((a, b) => b.score - a.score);

  // 5. Compress context to fit maxTokens with on-the-fly diversity check
  let currentTokens = 0;
  const accepted = [];

  for (const c of list) {
    // Skip if too similar to any already accepted memory to prevent redundant context bloat
    let isRedundant = false;
    for (const acc of accepted) {
      const sim = jaccardSimilarity(c.content, acc.content);
      if (sim > 0.60) {
        isRedundant = true;
        break;
      }
    }
    if (isRedundant) continue;

    // Heuristic: ~4 characters per token + format headers (~3 tokens for compact format)
    const estimatedTokens = Math.max(1, Math.ceil(c.content.length / 4) + 3);
    if (currentTokens + estimatedTokens > targetMaxTokens) {
      continue;
    }
    currentTokens += estimatedTokens;
    accepted.push(c);
  }

  const suggested_actions = generateSuggestedActions(accepted, intent, urgency);

  // 6. Format LLM injection context string
  let context = '=== RETRIEVED AGENT MEMORY CONTEXT ===\n';
  context += `[Intent: ${intent} | Urgency: ${urgency}]\n\n`;

  if (suggested_actions.length > 0) {
    context += '[Suggested Actions]\n';
    for (const action of suggested_actions) {
      context += `• ${action}\n`;
    }
    context += '\n';
  }

  context += '[Memories]\n';
  if (accepted.length === 0) {
    context += 'No relevant memories retrieved.\n';
  } else {
    for (const a of accepted) {
      context += `#${a.id}: ${a.content}\n`;
    }
  }
  context += '=== END OF CONTEXT ===';

  // Bug 8 fix: Skip attestation when no results to avoid audit noise
  let attestation = null;
  if (accepted.length > 0) {
    attestation = createAttestation(queryText, accepted, agentId, sessionId);
  }

  return {
    context,
    memories: accepted,
    attestation,
    intent,
    urgency,
    suggested_actions
  };
}

/**
 * Analyze relationship between two similar memories based on token sets.
 * @param {string} a - Content of memory A
 * @param {string} b - Content of memory B
 * @returns {{ type: 'duplicate'|'subset'|'contradiction'|'different', keep?: 'a'|'b'|'canonical' }}
 */
function checkRelationship(a, b) {
  const getWords = (text) => new Set(text.toLowerCase().split(/\s+/).map(w => w.replace(/[.,\/#!$%\^&\*;:{}=\-_`~()]/g, "")).filter(Boolean));
  const wordsA = getWords(a);
  const wordsB = getWords(b);

  if (wordsA.size === 0 || wordsB.size === 0) return { type: 'duplicate', keep: 'a' };

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const overlapA = intersection / wordsA.size;
  const overlapB = intersection / wordsB.size;

  const union = wordsA.size + wordsB.size - intersection;
  const jaccard = 1 - (intersection / union);

  if (jaccard === 0) {
    return { type: 'duplicate', keep: 'a' };
  }

  // Contradiction: similar topic, differing key terms
  if (jaccard > 0.15 && jaccard < 0.65) {
    return { type: 'contradiction' };
  }

  // Subset check
  if (overlapA > 0.85 && wordsB.size > wordsA.size) {
    return { type: 'subset', keep: 'b' };
  }
  if (overlapB > 0.85 && wordsA.size > wordsB.size) {
    return { type: 'subset', keep: 'a' };
  }

  // Duplicate
  if (jaccard < 0.25) {
    return { type: 'duplicate', keep: 'canonical' };
  }

  return { type: 'different' };
}

/**
 * Performs memory consolidation by merging highly similar memories.
 * Bug 6 fix: DB mutations are wrapped in a transaction for atomicity.
 */
export async function consolidateMemories(namespace = null) {
  if (namespace === 'all') throw new Error('Cross-workspace consolidation is disabled.');
  const access = new Set(['shared']);
  if (process.env.PERSYST_PROJECT) access.add(process.env.PERSYST_PROJECT.toLowerCase());
  if (namespace) String(namespace).split(',').forEach(value => access.add(value.trim().toLowerCase()));
  const allowed = Array.from(access).filter(Boolean);
  const placeholders = allowed.map(() => '?').join(',');
  const activeMemories = db.prepare(`
    SELECT * FROM memories
    WHERE workspace_id = ? AND valid_until IS NULL AND namespace IN (${placeholders})
  `).all(WORKSPACE_ID, ...allowed);

  // Consolidation is review-only. Retrieval heuristics may suggest merges, but
  // only an explicit update/delete operation is allowed to change durable facts.
  const proposals = [];
  const proposalVisited = new Set();
  for (const memory of activeMemories) {
    if (proposalVisited.has(memory.id)) continue;
    const embedding = stmts.getVecByRowId.get(memory.id);
    if (!embedding) continue;

    const candidates = [];
    for (const hit of stmts.consolidateVecSearch.all(embedding.embedding)) {
      const candidateId = Number(hit.id);
      if (candidateId === memory.id || proposalVisited.has(candidateId)) continue;
      const similarity = Math.max(0, 1 - (hit.distance * hit.distance) / 2);
      if (similarity <= 0.80) continue;
      const candidate = stmts.getMemoryByIdRaw.get(candidateId, WORKSPACE_ID);
      if (!candidate || !allowed.includes(candidate.namespace)) continue;
      const relationship = checkRelationship(memory.content, candidate.content);
      if (relationship.type === 'different') continue;
      candidates.push({
        id: candidate.id,
        content: candidate.content,
        similarity: Math.round(similarity * 10000) / 10000,
        relationship
      });
    }

    if (candidates.length > 0) {
      proposalVisited.add(memory.id);
      candidates.forEach(candidate => proposalVisited.add(candidate.id));
      proposals.push({
        canonical_candidate: { id: memory.id, content: memory.content },
        related_candidates: candidates,
        status: 'review_required'
      });
    }
  }

  return {
    success: true,
    mode: 'review_only',
    consolidated_groups: 0,
    proposed_groups: proposals.length,
    proposals,
    details: []
  };
}

/**
 * Classify context retrieval intent and urgency level using heuristic analysis.
 */
function classifyIntentAndUrgency(queryText, intentParam = null) {
  const queryLower = (queryText || '').toLowerCase();
  
  // 1. Determine Intent
  let intent = intentParam || 'general';
  if (intent === 'general' || !intent) {
    if (/(?:db|database|sqlite|sql|table|migration|schema)/i.test(queryLower)) {
      intent = 'database_management';
    } else if (/(?:deploy|ci|cd|vercel|publish|release|prod|staging)/i.test(queryLower)) {
      intent = 'deployment';
    } else if (/(?:style|css|html|theme|design|layout|align|color|font)/i.test(queryLower)) {
      intent = 'ui_styling';
    } else if (/(?:test|spec|unit|mock|heavy|smoke)/i.test(queryLower)) {
      intent = 'testing';
    } else if (/(?:error|bug|fail|crash|break|exception|stack|trace|refused|debug)/i.test(queryLower)) {
      intent = 'debugging';
    }
  }

  // 2. Determine Urgency
  let urgency = 'low';
  if (/(?:panic|emergency|broken|critical|urgent|fatal|security|leak|bypass|vulnerability)/i.test(queryLower)) {
    urgency = 'critical';
  } else if (/(?:fail|error|crash|prevent|stop|warn|warning|issue|broken)/i.test(queryLower)) {
    urgency = 'high';
  } else if (/(?:update|change|add|tweak|check|verify)/i.test(queryLower)) {
    urgency = 'medium';
  }

  return { intent, urgency };
}

/**
 * Generate actionable suggested actions based on active memories and query classification.
 */
function generateSuggestedActions(memories, intent, urgency) {
  const actions = [];

  // General recommendation based on intent
  if (intent === 'debugging') {
    actions.push('Inspect the recent error logs and verify SQLite/system constraints.');
  } else if (intent === 'ui_styling') {
    actions.push('Verify UI layouts conform to user design preferences.');
  } else if (intent === 'database_management') {
    actions.push('Ensure database migrations are applied and referential integrity is checked.');
  }

  for (const m of memories) {
    const content = m.content.toLowerCase();
    
    // Check for rules/decisions in memory content
    if (content.includes('decision:') || content.includes('rule:')) {
      actions.push(`Adhere to guideline: ${m.content.slice(0, 100)}...`);
    } else if (content.includes('prefer')) {
      actions.push(`Apply user preference: ${m.content.slice(0, 100)}...`);
    } else if (content.includes('error') || content.includes('bug') || content.includes('fix')) {
      actions.push(`Reference past fix: ${m.content.slice(0, 100)}...`);
    }
  }

  // Safety guideline if critical
  if (urgency === 'critical') {
    actions.unshift('CAUTION: Address security, vulnerability, or critical stability factors immediately.');
  }

  // Deduplicate
  return Array.from(new Set(actions));
}
