#!/usr/bin/env node
process.env.NODE_ENV = 'test';

import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'perf_hooks';
import db, {
  insertMemory,
  insertVector,
  deleteMemory,
  closeDatabase
} from '../src/database.js';
import { searchHybrid, getOptimizedContext } from '../src/search.js';
import { generateEmbedding } from '../src/embeddings.js';

import { addMemoryInternal } from '../src/tools.js';

test('ScopeKeep long-memory retrieval regression suite', async (t) => {
  // Clear memory database for test isolation
  db.exec('DELETE FROM memories; DELETE FROM memories_vec; DELETE FROM contradictions; DELETE FROM provenance;');

  const targetNeedles = [
    { text: 'Architecture Decision: Staging PostgreSQL port is set to non-standard 5439 for compliance audits.', topic: 'postgresql port' },
    { text: 'Rule: Legacy Auth Service API endpoint is restricted to /v1/old-auth.', topic: 'legacy auth endpoint' },
    { text: 'Milestone: Release v2.4.0 target deployment date is set for August 15.', topic: 'release deployment date' },
    { text: 'Rule: Code review standard requires at least 2 approvals before merging.', topic: 'code review approvals' },
    { text: 'Config: Production Redis cache TTL is set to 3600 seconds.', topic: 'redis cache ttl' }
  ];

  await t.test('1. Recall and ranking under 500 synthetic noise facts', async () => {
    // Seed 500 noise facts
    const noiseTopics = ['CSS flexbox centering', 'Docker multi-stage builds', 'JWT expiration', 'Kubernetes pod scaling', 'GraphQL resolver caching'];
    for (let i = 1; i <= 500; i++) {
      const topic = noiseTopics[i % noiseTopics.length];
      const noiseText = `Noise artifact #${i}: Developer convention regarding ${topic} in module ${i * 3}.`;
      const id = insertMemory(noiseText, 0.5, { source_type: 'agent', source_id: 'noise-gen', confidence: 0.5 }, 'shared');
      const emb = await generateEmbedding(noiseText);
      insertVector(id, emb);
    }

    // Seed 5 target needles
    for (const needle of targetNeedles) {
      const id = insertMemory(needle.text, 1.0, { source_type: 'user-dialogue', source_id: 'architect', confidence: 1.0 }, 'shared');
      const emb = await generateEmbedding(needle.text);
      insertVector(id, emb);
    }

    // Evaluate Retrieval for each needle
    let totalMRR = 0;
    let foundCount = 0;

    for (const needle of targetNeedles) {
      const hits = await searchHybrid(needle.topic, 5, null, null, 'shared');
      assert.ok(hits.length > 0, `Should return hits for topic: ${needle.topic}`);

      // Calculate Reciprocal Rank
      let rank = 0;
      for (let i = 0; i < hits.length; i++) {
        if (hits[i].content.includes(needle.topic) || hits[i].content.includes(needle.text)) {
          rank = i + 1;
          break;
        }
      }

      if (rank > 0) {
        foundCount++;
        totalMRR += (1 / rank);
      }
    }

    const meanMRR = totalMRR / targetNeedles.length;
    const recall = foundCount / targetNeedles.length;

    assert.equal(recall, 1.0, 'Synthetic Recall@5 must be 100% (all 5 needles retrieved)');
    assert.ok(meanMRR >= 0.80, `Mean Reciprocal Rank (MRR) must be >= 0.80 (actual MRR: ${meanMRR.toFixed(2)})`);
  });

  await t.test('2. Updated-fact ranking regression', async () => {
    const oldFact = 'Architecture Decision: Frontend framework is React 17.';
    const newFact = 'Architecture Decision: Frontend framework is upgraded to React 18 with concurrent mode.';

    const idOld = insertMemory(oldFact, 0.8, { source_type: 'agent', source_id: 'dev-1', confidence: 0.8 }, 'shared');
    const embOld = await generateEmbedding(oldFact);
    insertVector(idOld, embOld);

    const idNew = insertMemory(newFact, 1.0, { source_type: 'agent', source_id: 'dev-lead', confidence: 1.0 }, 'shared');
    const embNew = await generateEmbedding(newFact);
    insertVector(idNew, embNew);

    // Search for React 18 frontend framework
    const hits = await searchHybrid('React 18 concurrent mode frontend framework', 5, null, null, 'shared');
    assert.ok(hits.length > 0, 'Should return search hits');
    assert.equal(hits[0].content, newFact, 'Top hit must be the updated React 18 fact');
  });

  closeDatabase();
});
