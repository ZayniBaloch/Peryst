/**
 * tools.js — MCP Tool Definitions & Handlers
 * 
 * Defines the MCP tools that AI agents can call.
 * 
 * v2.0 changes:
 * - Bug 1: Uses memoryExistsByHashPrefix for git dedup
 * - Bug 3: Exports cleanupWatchers for graceful shutdown
 * - Bug 7 + Feature 4: Memory content size validation
 * - Feature 1: Cache invalidation on write operations
 * - Feature 2: Contradiction detection on add_memory
 */

import { z } from 'zod';
import { relative, resolve } from 'path';
import { generateEmbedding } from './embeddings.js';
import db, {
  stmts,
  insertMemory,
  insertVector,
  redactSecrets,
  getMemory,
  updateMemoryContent,
  deleteMemory,
  deleteVec,
  getRecentMemories,
  getMemoriesAsOf,
  getImportantMemories,
  insertEntity,
  getEntityByName,
  insertEdge,
  getMemoriesByEntity,
  getAllEntities,
  memoryExists,
  memoryExistsByHashPrefix,
  getMemoryByContent,
  boostMemory,
  logContradiction,
  getProvenance,
  incrementAgentStat,
  getAllAgentStats,
  getAttestationsByDateRange,
  getMemoryHistoryChain,
  searchAllMemoriesFts,
  getAnyMemoryById,
  searchVector,
  getMemoryById,
  getActiveMemoryCount,
  getNamespaceStats,
  WORKSPACE_ID,
  WORKSPACE_ROOT
} from './database.js';
import { searchHybrid, getOptimizedContext, consolidateMemories } from './search.js';
import { jaccardDistance } from './text-utils.js';
import { getRecentCommits } from './git.js';
import { verifyChainIntegrity } from './attestation.js';
import { searchCache } from './cache.js';
import { scanAndSanitize } from './secret-scanner.js';
import { memoryEventBus } from './events.js';

// ============================================================
// CONSTANTS
// ============================================================

/** Maximum allowed memory content length (10,000 characters) */
const MAX_MEMORY_CONTENT_LENGTH = 10000;

/** Minimum content length (must have actual content) */
const MIN_MEMORY_CONTENT_LENGTH = 1;

function getAccessNamespace(agentId = null) {
  const normalizedAgent = agentId ? String(agentId).trim().toLowerCase() : null;
  const project = process.env.PERSYST_PROJECT ? process.env.PERSYST_PROJECT.trim().toLowerCase() : null;
  return [normalizedAgent, project].filter(Boolean).join(',') || null;
}

function assertWorkspacePath(candidatePath) {
  const resolvedPath = resolve(candidatePath);
  const rel = relative(WORKSPACE_ROOT, resolvedPath);
  if (rel.startsWith('..') || resolve(WORKSPACE_ROOT, rel) !== resolvedPath) {
    throw new Error('Repository path must be inside the active workspace.');
  }
  return resolvedPath;
}

function parseAsOfTimestamp(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new Error('as_of must be a valid timestamp.');
    // Accept Unix seconds for CLI convenience, while storing/querying in ms.
    return Math.trunc(value < 100000000000 ? value * 1000 : value);
  }
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) {
    throw new Error('as_of must be an ISO-8601 date or Unix timestamp.');
  }
  return parsed;
}

// ============================================================
// WATCHER REGISTRY
// ============================================================

// In-memory registry of active git watchers
const watchers = new Map();

/**
 * Clean up all active git watchers. Called during graceful shutdown.
 * (Bug 3 fix: prevents memory leak from orphaned setInterval handles)
 */
export function cleanupWatchers() {
  for (const [repoPath, intervalId] of watchers.entries()) {
    clearInterval(intervalId);
    console.error(`[scopekeep-watcher] Stopped watching: ${repoPath}`);
  }
  watchers.clear();
}

// ============================================================
// VALIDATION HELPERS
// ============================================================

/**
 * Validate memory content for size and emptiness.
 * @param {string} content - The content to validate
 * @returns {{ valid: boolean, error?: string }} Validation result
 */
function validateMemoryContent(content) {
  if (!content || content.trim().length < MIN_MEMORY_CONTENT_LENGTH) {
    return { valid: false, error: 'Memory content cannot be empty or whitespace-only.' };
  }
  if (content.length > MAX_MEMORY_CONTENT_LENGTH) {
    return {
      valid: false,
      error: `Memory content exceeds maximum length of ${MAX_MEMORY_CONTENT_LENGTH} characters (got ${content.length}). Please split into smaller memories.`
    };
  }
  return { valid: true };
}

/**
 * Internal logic for storing a new memory (dedup, vector creation, contradiction detection).
 * Shared by both the stdio MCP tool and the HTTP Gateway server.
 */
export async function addMemoryInternal({ content, importance = 1.0, agent_id, session_id, shared = true }) {
  try {
    const normalizedAgentId = agent_id ? agent_id.toLowerCase() : null;

    // Redact secrets/credentials and PII on write
    const sanitized = scanAndSanitize(content);
    const redactedContent = redactSecrets(sanitized.sanitizedText);

    // Bug 7 + Feature 4: Validate content size
    const validation = validateMemoryContent(redactedContent);
    if (!validation.valid) {
      return { error: validation.error };
    }

    // Derive namespace from agent_id, project env, and shared flag
    const namespace = shared ? 'shared' : (normalizedAgentId || 'private');

    // Deduplication check (namespace-aware)
    const existing = getMemoryByContent(redactedContent, namespace);
    if (existing) {
      // Re-attribute provenance to the calling agent if it was previously auto-attributed to log-watcher
      const prov = getProvenance(existing.id);
      if (prov && (prov.source_id === 'antigravity-worker' || prov.source_id === 'user-dialogue') && normalizedAgentId) {
        try {
          stmts.updateProvenanceOwner.run(normalizedAgentId, existing.id);
          incrementAgentStat(normalizedAgentId, 'created');
        } catch (e) {
          console.error(`[scopekeep] Re-attribute provenance error: ${e.message}`);
        }
      }
      boostMemory(existing.id);
      return {
        success: true,
        id: existing.id,
        namespace,
        message: `Memory #${existing.id} already exists. Boosted importance.`
      };
    }

    const id = insertMemory(redactedContent, importance, {
      source_type: normalizedAgentId ? 'agent' : 'manual',
      source_id: normalizedAgentId,
      confidence: 1.0
    }, namespace);

    const embedding = await generateEmbedding(redactedContent);
    insertVector(id, embedding);

    // Feature 1: Invalidate search cache on write
    searchCache.invalidate();

    // Broadcast to SSE subscribers (HTTP gateway + SSE clients)
    memoryEventBus.emit('memory_added', { id, content: redactedContent, namespace, source: normalizedAgentId || 'manual' });

    // Feature 2: Contradiction Detection
    let contradictions = [];
    try {
      const similarHits = searchVector(embedding, 20, getAccessNamespace(normalizedAgentId));
      for (const hit of similarHits) {
        const hitId = Number(hit.rowid);
        if (hitId === id) continue; // Skip self

        const sim = Math.max(0, 1 - (hit.distance * hit.distance) / 2);
        if (sim > 0.70) {
          const existingMemory = getMemoryById(hitId, namespace);
          if (!existingMemory) continue;

          const jaccard = jaccardDistance(redactedContent, existingMemory.content);
          // Contradiction: similar topic (high similarity), but differing key terms
          if (jaccard > 0 && jaccard < 0.65) {
            // Fetch provenances for trust calculation
            const oldProv = getProvenance(hitId);
            let oldReputation = 1.0;
            if (oldProv && oldProv.source_type === 'agent' && oldProv.source_id) {
              const agentRow = stmts.getReputationScore.get(oldProv.source_id, WORKSPACE_ID);
              if (agentRow) oldReputation = agentRow.reputation_score;
            }

            let newReputation = 1.0;
            if (normalizedAgentId) {
              const agentRow = stmts.getReputationScore.get(normalizedAgentId, WORKSPACE_ID);
              if (agentRow) newReputation = agentRow.reputation_score;
            }

            const trustOld = (oldProv ? oldProv.confidence : 1.0) * oldReputation;
            const trustNew = 1.0 * newReputation; // New confidence is 1.0

            const isSelfUpdate = oldProv && oldProv.source_type === 'agent' && oldProv.source_id === normalizedAgentId;

            if (isSelfUpdate) {
              continue; // Same agent: treat as complementary, not contradictory
            }

            contradictions.push({
              existing_memory_id: hitId,
              existing_content_preview: existingMemory.content.slice(0, 100),
              similarity: sim.toFixed(4),
              content_difference: jaccard.toFixed(4),
              suggested_resolution: trustNew > trustOld ? 'prefer_new' : 'prefer_existing',
              status: 'review_required'
            });
          }
        }
      }
    } catch (e) {
      console.error(`[scopekeep] Contradiction detection error: ${e.message}`);
    }

    const result = { success: true, id, namespace, message: `Memory #${id} stored` };
    if (contradictions.length > 0) {
      result.contradictions_detected = contradictions;
      result.message += `. Detected ${contradictions.length} contradiction(s) — older memories archived.`;
    }

    if (contradictions.length > 0) {
      result.message = `Memory #${id} stored. Detected ${contradictions.length} possible contradiction(s); no memory was archived automatically.`;
    }
    return result;
  } catch (err) {
    return { error: err.message };
  }
}

const toolHandlers = new Map();

const READ_ONLY_TOOLS = new Set([
  'search_memories',
  'get_memory',
  'get_recent_memories',
  'get_memories_as_of',
  'get_important_memories',
  'get_relationships',
  'get_memory_versions',
  'get_agent_stats',
  'export_audit_log',
  'verify_attestation',
  'get_file_history',
  'get_optimized_context',
  'consolidate_memories'
]);

const DESTRUCTIVE_TOOLS = new Set(['delete_memory', 'delete_entity']);

function getToolAnnotations(name) {
  const readOnly = READ_ONLY_TOOLS.has(name);
  const destructive = DESTRUCTIVE_TOOLS.has(name);
  return {
    readOnlyHint: readOnly,
    destructiveHint: destructive,
    idempotentHint: readOnly || destructive,
    openWorldHint: false
  };
}

/**
 * Programmatically execute any registered MCP tool.
 * Used by the HTTP Gateway server to route requests to tool handlers.
 */
export async function executeToolInternal(name, args) {
  const handler = toolHandlers.get(name);
  if (!handler) {
    throw new Error(`Tool ${name} not found`);
  }
  return await handler(args);
}

/**
 * Register all MCP tools on the server.
 * @param {McpServer} server - The MCP server instance
 * @returns {number} The total count of registered tools
 */
export function registerTools(server) {
  let count = 0;
  const originalTool = server.tool.bind(server);
  server.tool = (...args) => {
    const name = args[0];
    const handler = args[args.length - 1];
    if (typeof handler === 'function') {
      toolHandlers.set(name, handler);
    }
    originalTool(
      ...args.slice(0, -1),
      getToolAnnotations(name),
      handler
    );
    count++;
  };

  // ============================================================
  // CORE TOOLS
  // ============================================================

  // 1. ADD MEMORY
  server.tool(
    'add_memory',
    'Store a new memory. CRITICAL: Call this tool proactively to store important milestones, architectural decisions, and explicit user preferences. Always specify your agent name as agent_id to support namespace isolation.',
    {
      content: z.string().describe('The memory content to store'),
      importance: z.number().min(0).max(1).default(1.0).describe('Importance score from 0 (low) to 1 (high)'),
      agent_id: z.string().optional().describe('Agent ID for provenance tracking and namespace isolation'),
      session_id: z.string().optional().describe('Session ID'),
      shared: z.boolean().default(true).describe('If true, memory is visible to all agents. If false, only visible to this agent.')
    },
    async ({ content, importance, agent_id, session_id, shared }) => {
      const res = await addMemoryInternal({ content, importance, agent_id, session_id, shared });
      if (res.error) {
        return text({ error: res.error });
      }
      return text(res);
    }
  );

  // 2. SEARCH MEMORIES
  server.tool(
    'search_memories',
    'Search memories using hybrid keyword + semantic search with cryptographic attestation. CRITICAL: Call this tool at the start of a session or task to retrieve relevant user preferences, coding guidelines, and past decisions.',
    {
      query: z.string().describe('What to search for'),
      limit: z.number().int().min(1).default(5).describe('Max results (default: 5)'),
      agent_id: z.string().optional().describe('Agent ID — filters results to this agent\'s namespace + shared'),
      session_id: z.string().optional().describe('Session ID')
    },
    async ({ query, limit, agent_id, session_id }) => {
      try {
        // Derive namespace from agent_id or PERSYST_PROJECT env
        const namespace = getAccessNamespace(agent_id);
        const results = await searchHybrid(query, limit, agent_id, session_id, namespace);

        // Broadcast retrieval event to SSE subscribers and monitor
        if (results && results.length > 0) {
          memoryEventBus.emit('memory_retrieved', {
            tool: 'search_memories',
            query,
            count: results.length,
            agent_id: agent_id || 'unknown',
            namespace: namespace || 'shared',
            memory_ids: results.map(r => r.id)
          });
        }

        return text({
          results,
          count: results.length,
          namespace: namespace || 'shared',
          attestation: results.attestation
        });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 3. GET MEMORY
  server.tool(
    'get_memory',
    'Get a specific memory by its ID. Boosts its importance automatically.',
    {
      id: z.number().describe('Memory ID to retrieve'),
      agent_id: z.string().optional().describe('Agent ID — restricts access to this agent\'s namespace + shared')
    },
    async ({ id, agent_id }) => {
      try {
        const namespace = getAccessNamespace(agent_id);
        const memory = getMemory(id, namespace);
        if (!memory) return text({ error: `Memory #${id} not found` });

        // Broadcast retrieval event
        memoryEventBus.emit('memory_retrieved', {
          tool: 'get_memory',
          query: `#${id}`,
          count: 1,
          agent_id: agent_id || 'unknown',
          namespace: memory.namespace || 'shared',
          memory_ids: [id]
        });

        return text(memory);
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 4. UPDATE MEMORY
  server.tool(
    'update_memory',
    'Update the content of an existing memory. Archives the old content and saves the new version.',
    {
      id: z.number().describe('Memory ID to update'),
      content: z.string().describe('New memory content'),
      agent_id: z.string().optional().describe('Agent ID making this update')
    },
    async ({ id, content, agent_id }) => {
      try {
        const normalizedAgentId = agent_id ? agent_id.toLowerCase() : null;

        // Redact secrets/credentials on update
        const redactedContent = redactSecrets(content);

        // Bug 7 + Feature 4: Validate content size
        const validation = validateMemoryContent(redactedContent);
        if (!validation.valid) {
          return text({ error: validation.error });
        }

        const namespace = getAccessNamespace(normalizedAgentId);
        const oldMemory = getMemory(id, namespace);
        if (!oldMemory) return text({ error: `Memory #${id} not found` });

        // Retrieve old agent_id from provenance
        const oldProv = getProvenance(id);
        const resolvedAgentId = normalizedAgentId || (oldProv && oldProv.source_type === 'agent' ? oldProv.source_id : null);

        // Insert new version
        const newId = insertMemory(
          redactedContent,
          oldMemory.importance_score,
          {
            source_type: resolvedAgentId ? 'agent' : 'manual',
            source_id: resolvedAgentId,
            confidence: 1.0
          },
          oldMemory.namespace || 'shared',
          id
        );

        const embedding = await generateEmbedding(redactedContent);
        insertVector(newId, embedding);

        // Record contradiction and archive the old one
        logContradiction(id, newId, 'Content updated via update_memory');

        // Feature 1: Invalidate search cache on write
        searchCache.invalidate();

        // Broadcast update to SSE subscribers
        memoryEventBus.emit('memory_updated', { old_id: id, new_id: newId, namespace: oldMemory.namespace || 'shared' });

        return text({
          success: true,
          id: newId,
          message: `Memory #${id} updated. New version stored as #${newId}`
        });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 5. DELETE MEMORY
  server.tool(
    'delete_memory',
    'Permanently delete a memory by its ID.',
    {
      id: z.number().describe('Memory ID to delete'),
      agent_id: z.string().optional().describe('Agent ID — restricts deletion to this agent\'s namespace + shared')
    },
    async ({ id, agent_id }) => {
      try {
        const namespace = getAccessNamespace(agent_id);
        const memory = getMemory(id, namespace);
        if (!memory) return text({ error: `Memory #${id} not found` });

        const deleted = deleteMemory(id, namespace);
        if (!deleted) return text({ error: `Memory #${id} not found` });

        // Feature 1: Invalidate search cache on write
        searchCache.invalidate();

        // Broadcast deletion to SSE subscribers
        memoryEventBus.emit('memory_deleted', { id, namespace: memory.namespace || 'shared' });

        return text({ success: true, id, message: `Memory #${id} deleted` });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 6. GET RECENT MEMORIES
  server.tool(
    'get_recent_memories',
    'Get the most recently created memories, newest first. Filtered by agent namespace if agent_id is provided.',
    {
      limit: z.number().int().min(1).default(10).describe('How many to return (default: 10)'),
      agent_id: z.string().optional().describe('Agent ID — filters to this agent\'s namespace + shared')
    },
    async ({ limit, agent_id }) => {
      try {
        const namespace = getAccessNamespace(agent_id);
        const memories = getRecentMemories(limit, namespace);
        return text({ memories, count: memories.length, namespace: namespace || 'shared' });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 6b. GET MEMORIES AS OF A HISTORICAL INSTANT
  server.tool(
    'get_memories_as_of',
    'Reconstruct the workspace memories that were valid and known at a specific time. Useful for incident review, audits, and explaining which context an agent could have used.',
    {
      as_of: z.union([z.string(), z.number()]).describe('ISO-8601 date or Unix timestamp (seconds or milliseconds)'),
      limit: z.number().int().min(1).max(500).default(50).describe('How many memories to return (default: 50, max: 500)'),
      agent_id: z.string().optional().describe('Agent ID — filters to this agent\'s namespace + shared')
    },
    async ({ as_of, limit, agent_id }) => {
      try {
        const timestamp = parseAsOfTimestamp(as_of);
        const namespace = getAccessNamespace(agent_id);
        const memories = getMemoriesAsOf(timestamp, limit, namespace);
        return text({
          memories,
          count: memories.length,
          as_of: new Date(timestamp).toISOString(),
          as_of_unix_ms: timestamp,
          namespace: namespace || 'shared'
        });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 7. GET IMPORTANT MEMORIES
  server.tool(
    'get_important_memories',
    'Get memories ranked by importance score, highest first. Filtered by agent namespace if agent_id is provided.',
    {
      limit: z.number().int().min(1).default(10).describe('How many to return (default: 10)'),
      agent_id: z.string().optional().describe('Agent ID — filters to this agent\'s namespace + shared')
    },
    async ({ limit, agent_id }) => {
      try {
        const namespace = getAccessNamespace(agent_id);
        const memories = getImportantMemories(limit, namespace);
        return text({ memories, count: memories.length, namespace: namespace || 'shared' });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 8. INGEST GIT COMMITS
  server.tool(
    'ingest_git_commits',
    'Import recent git commits, parse PR/file links, and categorize decisions.',
    {
      repo_path: z.string().describe('Absolute path to the git repository'),
      count: z.number().default(20).describe('Number of recent commits to import (default: 20)')
    },
    async ({ repo_path, count }) => {
      try {
        const scopedRepoPath = assertWorkspacePath(repo_path);
        const commits = await getRecentCommits(scopedRepoPath, count);
        let added = 0;
        let skipped = 0;

        for (const commit of commits) {
          const hashPrefix = commit.hash.slice(0, 7);
          // Bug 1 fix: use LIKE-based query for hash prefix matching
          if (memoryExistsByHashPrefix(`[${hashPrefix}]%`)) {
            skipped++;
            continue;
          }

          // Insert memory with provenance
          const id = insertMemory(commit.fullText, commit.importance, {
            source_type: 'git',
            source_id: commit.hash,
            confidence: 0.8
          }, process.env.PERSYST_PROJECT || 'shared');

          const embedding = await generateEmbedding(commit.fullText);
          insertVector(id, embedding);

          // Link Author
          const authorId = insertEntity(commit.author, 'person');
          if (authorId) {
            insertEdge(authorId, id, 'authored', 'entity', 'memory');
          }

          // Link Files Touched
          for (const file of commit.files) {
            const fileId = insertEntity(file, 'file');
            if (fileId) {
              insertEdge(fileId, id, 'touches', 'entity', 'memory');
            }
          }

          added++;
        }

        // Feature 1: Invalidate search cache after git ingestion
        if (added > 0) searchCache.invalidate();

        return text({
          success: true,
          added,
          skipped,
          total_commits: commits.length,
          message: `Ingested ${added} commits (${skipped} already existed)`
        });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 9. ADD ENTITY
  server.tool(
    'add_entity',
    'Create a named entity (person, tech, project, concept, file).',
    {
      name: z.string().describe('Entity name (e.g. "React", "auth-service")'),
      type: z.string().describe('Entity type: person, tech, project, concept, file')
    },
    async ({ name, type }) => {
      try {
        const id = insertEntity(name, type);
        return text({ success: true, id, name, type, message: `Entity "${name}" created` });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 10. LINK ENTITY TO MEMORY
  server.tool(
    'link_entity_memory',
    'Connect an entity to a memory with a relationship label.',
    {
      entity_name: z.string().describe('Name of the entity'),
      memory_id: z.number().describe('ID of the memory to link'),
      relation: z.string().default('mentions').describe('Relationship type'),
      agent_id: z.string().optional().describe('Agent ID — restricts linking to this agent\'s namespace + shared')
    },
    async ({ entity_name, memory_id, relation, agent_id }) => {
      try {
        const namespace = getAccessNamespace(agent_id);
        const entity = getEntityByName(entity_name);
        if (!entity) return text({ error: `Entity "${entity_name}" not found.` });

        const memory = getMemory(memory_id, namespace);
        if (!memory) return text({ error: `Memory #${memory_id} not found` });

        insertEdge(entity.id, memory_id, relation, 'entity', 'memory');
        return text({ success: true, entity: entity_name, memory_id, relation });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 11. SEARCH BY ENTITY
  server.tool(
    'search_by_entity',
    'Find all memories linked to a specific entity.',
    {
      entity_name: z.string().describe('Name of the entity to search for'),
      agent_id: z.string().optional().describe('Agent ID used to enforce private-memory visibility')
    },
    async ({ entity_name, agent_id }) => {
      try {
        const entity = getEntityByName(entity_name);
        if (!entity) return text({ error: `Entity "${entity_name}" not found` });

        const memories = getMemoriesByEntity(entity.id, getAccessNamespace(agent_id));
        return text({ entity, memories, count: memories.length });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // ============================================================
  // PRODUCTION-GRADE / NEW TOOLS
  // ============================================================

  // 12. GET MEMORY HISTORY
  server.tool(
    'get_memory_history',
    'Retrieve all versions of a memory, including archived versions and contradictions.',
    {
      query: z.string().describe('The content or search query to find the memory versions for')
    },
    async ({ query }) => {
      try {
        let hits = [];
        const queryAsId = Number(query);
        if (!isNaN(queryAsId) && Number.isInteger(queryAsId)) {
          const mem = getAnyMemoryById(queryAsId);
          if (mem) {
            hits.push({ id: mem.id });
          }
        }

        if (hits.length === 0) {
          hits = searchAllMemoriesFts(query, 5);
        }

        // Fallback to LIKE query on memories content if FTS is empty or fails
        if (hits.length === 0) {
          try {
            const likeRows = db.prepare(
              'SELECT id FROM memories WHERE workspace_id = ? AND content LIKE ? LIMIT 5'
            ).all(WORKSPACE_ID, `%${query}%`);
            hits = likeRows;
          } catch (_) {}
        }

        if (hits.length === 0) {
          return text({ message: 'No memories matching query found.' });
        }

        const histories = {};
        const seenChainKeys = new Set();
        for (const hit of hits) {
          const chain = getMemoryHistoryChain(hit.id);
          if (chain.length === 0) continue;

          // Deduplicate chains to prevent duplicate entries in history response
          const chainKey = chain.map(c => c.id).sort((a, b) => a - b).join(',');
          if (seenChainKeys.has(chainKey)) continue;
          seenChainKeys.add(chainKey);

          // Decorate chain versions with semantic diffs from the previous version
          for (let idx = 0; idx < chain.length; idx++) {
            if (idx > 0) {
              chain[idx].diff_from_previous = diffWords(chain[idx - 1].content, chain[idx].content);
            } else {
              chain[idx].diff_from_previous = null;
            }
          }
          histories[hit.id] = chain;
        }

        return text({ query, histories });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 13. GET AGENT STATS
  server.tool(
    'get_agent_stats',
    'Retrieve reputation statistics and activity logs for all active agents.',
    {},
    async () => {
      try {
        const stats = getAllAgentStats();
        return text({ stats, count: stats.length });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 14. EXPORT AUDIT LOG
  server.tool(
    'export_audit_log',
    'Exports query attestation log records within a timestamp range for compliance audits.',
    {
      start_date: z.string().describe('Start date ISO8601 (e.g. 2026-06-01T00:00:00Z)'),
      end_date: z.string().describe('End date ISO8601')
    },
    async ({ start_date, end_date }) => {
      try {
        const logs = getAttestationsByDateRange(start_date, end_date);
        return text({ logs, count: logs.length });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 15. VERIFY ATTESTATION
  server.tool(
    'verify_attestation',
    'Verify the Ed25519 signature and hash-chain integrity of a specific attestation.',
    {
      attestation_id: z.string().describe('The UUID of the attestation to verify')
    },
    async ({ attestation_id }) => {
      try {
        const report = verifyChainIntegrity(attestation_id);
        return text(report);
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 16. GET FILE HISTORY
  server.tool(
    'get_file_history',
    'Fetch all commit memories and architectural choices that modified a specific file.',
    {
      file_path: z.string().describe('Relative or absolute file path'),
      agent_id: z.string().optional().describe('Agent ID used to enforce private-memory visibility')
    },
    async ({ file_path, agent_id }) => {
      try {
        const entity = getEntityByName(file_path);
        if (!entity) return text({ message: `No git history entity found for file: ${file_path}`, memories: [] });

        const memories = getMemoriesByEntity(entity.id, getAccessNamespace(agent_id));
        return text({ file_path, memories, count: memories.length });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 17. WATCH GIT REPO
  server.tool(
    'watch_git_repo',
    'Subscribe to and poll a repository for changes, auto-ingesting new commits every 5 minutes.',
    {
      repo_path: z.string().describe('Absolute path to the repository')
    },
    async ({ repo_path }) => {
      try {
        const scopedRepoPath = assertWorkspacePath(repo_path);
        if (watchers.has(scopedRepoPath)) {
          return text({ success: true, message: `Repository ${scopedRepoPath} is already being watched.` });
        }

        const intervalId = setInterval(async () => {
          console.error(`[scopekeep-watcher] Running scheduled ingestion for: ${scopedRepoPath}`);
          try {
            const result = await getRecentCommits(scopedRepoPath, 10);
            let added = 0;
            for (const commit of result) {
              const hashPrefix = commit.hash.slice(0, 7);
              // Bug 1 fix: use LIKE-based query for hash prefix matching
              if (memoryExistsByHashPrefix(`[${hashPrefix}]%`)) continue;

              const id = insertMemory(commit.fullText, commit.importance, {
                source_type: 'git',
                source_id: commit.hash,
                confidence: 0.8
              });
              const embedding = await generateEmbedding(commit.fullText);
              insertVector(id, embedding);

              const authorId = insertEntity(commit.author, 'person');
              if (authorId) insertEdge(authorId, id, 'authored', 'entity', 'memory');

              for (const file of commit.files) {
                const fileId = insertEntity(file, 'file');
                if (fileId) insertEdge(fileId, id, 'touches', 'entity', 'memory');
              }
              added++;
            }
            if (added > 0) {
              searchCache.invalidate();
              console.error(`[scopekeep-watcher] Ingested ${added} new commits from ${scopedRepoPath}`);
            }
          } catch (e) {
            console.error(`[scopekeep-watcher] Ingestion failed for ${scopedRepoPath}: ${e.message}`);
          }
        }, 300000); // 5 minutes

        watchers.set(scopedRepoPath, intervalId);
        return text({ success: true, message: `Started watching repository at ${scopedRepoPath}` });
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 18. GET OPTIMIZED CONTEXT
  server.tool(
    'get_optimized_context',
    'Compile a condensed context prompt within a token budget by hopping the knowledge graph and ranking by temporal decay + agent reputation. CRITICAL: Invoke this tool at the start of a task to load all relevant conventions and decisions.',
    {
      query: z.string().describe('The search query context'),
      max_tokens: z.number().default(4000).describe('Token budget for LLM context compression (default: 4000)'),
      agent_id: z.string().optional().describe('Agent ID requesting context — filters to this agent\'s namespace + shared'),
      session_id: z.string().optional().describe('Session ID'),
      intent: z.string().optional().describe('The active task intent / category (e.g. debugging, ui_styling, database_management)')
    },
    async ({ query, max_tokens, agent_id, session_id, intent }) => {
      try {
        const namespace = getAccessNamespace(agent_id);
        const contextData = await getOptimizedContext(query, max_tokens, agent_id, session_id, namespace, intent);

        // Broadcast context retrieval event
        const retrievedCount = contextData?.memories?.length ?? 0;
        if (retrievedCount > 0) {
          memoryEventBus.emit('memory_retrieved', {
            tool: 'get_optimized_context',
            query,
            count: retrievedCount,
            agent_id: agent_id || 'unknown',
            namespace: namespace || 'shared',
            token_budget: max_tokens,
            memory_ids: contextData.memories.map(m => m.id)
          });
        }

        return text(contextData);
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // 19. CONSOLIDATE MEMORIES
  server.tool(
    'consolidate_memories',
    'Review highly similar memories and return non-destructive merge proposals. Durable facts are never changed automatically.',
    {},
    async () => {
      try {
        const report = await consolidateMemories(getAccessNamespace(null));
        return text(report);
      } catch (err) {
        return text({ error: err.message });
      }
    }
  );

  // Restore original method and return count
  server.tool = originalTool;
  return count;
}

// ============================================================
// HELPERS
// ============================================================

/** Format a response as MCP text content */
function text(data) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }]
  };
}

/**
 * Compute word-level diff between two text strings using dynamic programming.
 * Highlights additions as [+added+] and deletions as [-deleted-].
 * @param {string} oldStr - Original text
 * @param {string} newStr - New version of text
 * @returns {string} Diff string
 */
function diffWords(oldStr, newStr) {
  const oldWords = oldStr.split(/(\s+)/);
  const newWords = newStr.split(/(\s+)/);
  
  const dp = Array(oldWords.length + 1).fill(0).map(() => Array(newWords.length + 1).fill(0));
  
  for (let i = 1; i <= oldWords.length; i++) {
    for (let j = 1; j <= newWords.length; j++) {
      if (oldWords[i-1] === newWords[j-1]) {
        dp[i][j] = dp[i-1][j-1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
      }
    }
  }
  
  let i = oldWords.length;
  let j = newWords.length;
  const result = [];
  
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i-1] === newWords[j-1]) {
      result.unshift({ type: 'common', value: oldWords[i-1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j-1] >= dp[i-1][j])) {
      result.unshift({ type: 'added', value: newWords[j-1] });
      j--;
    } else {
      result.unshift({ type: 'removed', value: oldWords[i-1] });
      i--;
    }
  }

  // Combine consecutive items of the same type
  const combined = [];
  for (const part of result) {
    if (combined.length > 0 && combined[combined.length - 1].type === part.type) {
      combined[combined.length - 1].value += part.value;
    } else {
      combined.push({ ...part });
    }
  }

  return combined.map(part => {
    if (part.type === 'added') return `[+${part.value}+]`;
    if (part.type === 'removed') return `[-${part.value}-]`;
    return part.value;
  }).join('');
}
