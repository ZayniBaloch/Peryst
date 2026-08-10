#!/usr/bin/env node
process.env.NODE_ENV = 'test';

import test from 'node:test';
import assert from 'node:assert/strict';
import db, { insertMemory, closeDatabase } from '../src/database.js';
import { categorizeFact, buildHierarchyTree, getSubtreeForQuery } from '../src/hierarchy.js';
import { predictNextContext } from '../src/context-predictor.js';

test('ScopeKeep Hierarchical Knowledge Trees & Context Predictor Test', async (t) => {
  // Clear memory database for test isolation
  db.exec('DELETE FROM memories; DELETE FROM memories_vec; DELETE FROM contradictions; DELETE FROM provenance;');

  await t.test('1. categorizeFact accurately groups facts into hierarchy categories', () => {
    assert.equal(categorizeFact('STACK: Node.js, SQLite, sqlite-vec'), 'STACK');
    assert.equal(categorizeFact('COMPLIANCE GATES: GDPR vector erasure verified'), 'COMPLIANCE');
    assert.equal(categorizeFact('DEPLOYMENT: Docker image pushed to repository'), 'DEPLOYMENT');
    assert.equal(categorizeFact('Preference: Direct, logical, concise tone'), 'USER_PREFERENCES');
  });

  await t.test('2. buildHierarchyTree clusters memories into Level 2 Category Nodes', () => {
    insertMemory('STACK: Built with better-sqlite3 and sqlite-vec', 1.0, null, 'shared');
    insertMemory('COMPLIANCE GATES: HIPAA mapping and PHI boundary controls', 1.0, null, 'shared');
    insertMemory('DEPLOYMENT: Automated release build via GitHub Actions', 1.0, null, 'shared');

    const tree = buildHierarchyTree('shared');
    assert.ok(tree, 'Tree object should exist');
    assert.equal(tree.level, 1, 'Root level should be 1');
    assert.ok(tree.categories.length >= 3, 'Should create category cluster nodes');
  });

  await t.test('3. getSubtreeForQuery retrieves single dense category summary node', () => {
    const summary = getSubtreeForQuery('how do I handle deployment and releases?', 'shared');
    assert.ok(summary, 'Should return category summary');
    assert.ok(summary.startsWith('DEPLOYMENT:'), 'Summary should be for DEPLOYMENT category');
  });

  await t.test('4. predictNextContext pre-compiles dense intent context', () => {
    const predicted = predictNextContext('antigravity-worker', 'shared');
    assert.ok(Array.isArray(predicted), 'Should return array of dense summaries');
    assert.ok(predicted.length > 0, 'Should return non-empty intent summaries');
  });

  closeDatabase();
});
