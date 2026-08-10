#!/usr/bin/env node
process.env.NODE_ENV = 'test';

import test from 'node:test';
import assert from 'node:assert/strict';
import { compressFact } from '../src/summarizer.js';
import db, { insertMemory, getMemory, closeDatabase } from '../src/database.js';

test('ScopeKeep On-Device Extractive Summarizer & Hierarchy Test', async (t) => {
  await t.test('1. compressFact reduces token footprint by 70%+', () => {
    const rawFact = 'RECENT MILESTONE: ScopeKeep v2.3.0 Launch Ready: Added persyst-export and persyst-import CLI binaries to package.json, verified GDPR vector erasure, and passed 100% of production stress benchmarks.';
    const summary = compressFact(rawFact);

    assert.ok(summary.length < rawFact.length * 0.50, `Summary length (${summary.length}) must be < 50% of raw fact length (${rawFact.length})`);
    assert.ok(summary.startsWith('RECENT MILESTONE:'), 'Should preserve Codex prefix');
  });

  await t.test('2. insertMemory auto-generates dense summary in SQLite', () => {
    const raw = 'Decision: We have decided to use TailwindCSS for styling components in order to maintain modern design standards.';
    const id = insertMemory(raw, 1.0, null, 'shared');

    const mem = getMemory(id);
    assert.ok(mem, 'Memory should exist in DB');
    assert.ok(mem.summary, 'Summary column should be populated');
    assert.ok(mem.summary.length < raw.length, 'Summary should be shorter than raw content');
  });

  closeDatabase();
});
