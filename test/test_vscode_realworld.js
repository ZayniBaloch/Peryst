#!/usr/bin/env node
process.env.NODE_ENV = 'test';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import Database from 'better-sqlite3-multiple-ciphers';
import db, { getMemoryById, closeDatabase } from '../src/database.js';
import { handleFileChange } from '../src/watcher.js';

test('Real-World VS Code & Cursor SQLite state.vscdb Ingestion Test', async (t) => {
  const testDir = join(tmpdir(), `persyst_vscode_test_${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  const dbPath = join(testDir, 'state.vscdb');

  // Create real-world VS Code state.vscdb SQLite schema and data
  const vscDb = new Database(dbPath);
  vscDb.exec(`
    CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);
    INSERT INTO ItemTable (key, value) VALUES (
      'interactive.sessions',
      '{"history": [{"role": "user", "content": "Note: Real-world VS Code deployment port is set to 8088"}]}'
    );
  `);
  vscDb.close();

  await t.test('1. Watcher parses real-world VS Code state.vscdb SQLite database', async () => {
    const addedCount = await handleFileChange(dbPath);
    assert.ok(addedCount >= 1, `Watcher should extract at least 1 memory from VS Code state.vscdb (actual: ${addedCount})`);
  });

  // Cleanup
  try { rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
  closeDatabase();
});
