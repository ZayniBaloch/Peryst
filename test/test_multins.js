process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  insertMemory,
  insertVector,
  getRecentMemories,
  getMemoryById,
  getActiveMemoryCount,
  closeDatabase
} from '../src/database.js';
import { generateEmbedding } from '../src/embeddings.js';
import { searchHybrid } from '../src/search.js';

test('Combined Agent and Project Namespaces', async (t) => {
  // Test data setup
  const sharedText = 'Shared memory that anyone can see';
  const projectText = 'Project-specific rule: use tabs for formatting';
  const agentText = 'Agent-private secret credential key';
  const otherText = 'Other agent private preference';

  const sharedId = insertMemory(sharedText, 1.0, null, 'shared');
  const sharedEmb = await generateEmbedding(sharedText);
  insertVector(sharedId, sharedEmb);

  const projectId = insertMemory(projectText, 1.0, null, 'proj-test');
  const projectEmb = await generateEmbedding(projectText);
  insertVector(projectId, projectEmb);

  const agentId = insertMemory(agentText, 1.0, null, 'agent-test');
  const agentEmb = await generateEmbedding(agentText);
  insertVector(agentId, agentEmb);

  const otherId = insertMemory(otherText, 1.0, null, 'other-test');
  const otherEmb = await generateEmbedding(otherText);
  insertVector(otherId, otherEmb);

  await t.test('1. Combined namespace retrieves own, project, and shared memories', () => {
    const combinedNs = 'agent-test,proj-test';
    const recent = getRecentMemories(50, combinedNs);
    const ids = recent.map(m => m.id);

    assert.ok(ids.includes(sharedId), 'Should contain shared memory');
    assert.ok(ids.includes(projectId), 'Should contain project memory');
    assert.ok(ids.includes(agentId), 'Should contain agent private memory');
    assert.ok(!ids.includes(otherId), 'Should NOT contain other agent memory');
  });

  await t.test('2. getMemoryById works with combined namespace', () => {
    const combinedNs = 'agent-test,proj-test';
    
    assert.ok(getMemoryById(sharedId, combinedNs) !== null, 'Should get shared memory by ID');
    assert.ok(getMemoryById(projectId, combinedNs) !== null, 'Should get project memory by ID');
    assert.ok(getMemoryById(agentId, combinedNs) !== null, 'Should get agent memory by ID');
    assert.equal(getMemoryById(otherId, combinedNs), null, 'Should NOT get other agent memory by ID');
  });

  await t.test('3. getActiveMemoryCount works with combined namespace', () => {
    const combinedNs = 'agent-test,proj-test';
    // Count should be 3 (shared, project, agent)
    const count = getActiveMemoryCount(combinedNs);
    assert.equal(count, 3, 'Should count exactly 3 active memories in the combined namespace');
  });

  await t.test('4. Hybrid Search works with combined namespace', async () => {
    const combinedNs = 'agent-test,proj-test';
    const results = await searchHybrid('tabs', 5, 'agent-test', null, combinedNs);
    
    assert.ok(results.length > 0, 'Should find search results');
    assert.ok(results.some(r => r.content.includes('tabs')), 'Should find project memory about tabs');
  });

  closeDatabase();
});
