process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { autoRepoIngest } from '../src/repo-ingest.js';
import { getRecentMemories, closeDatabase } from '../src/database.js';

test('Automatic Repository Baseline Ingestion', async (t) => {
  // Setup temp repository directory
  const tempDir = mkdtempSync(join(tmpdir(), 'persyst-test-repo-'));
  
  // Create mock package.json
  const pkgContent = JSON.stringify({
    name: 'test-app-service',
    description: 'High performance caching microservice built for cloud native environments',
    dependencies: {
      'express': '^4.18.0',
      'better-sqlite3': '^11.0.0',
      'zod': '^3.20.0'
    }
  }, null, 2);
  writeFileSync(join(tempDir, 'package.json'), pkgContent, 'utf8');

  // Create mock README.md
  const readmeContent = `
# Test App Microservice Architecture
Fast lightweight service for session storage.

- Built with SQLite for zero-latency local caching.
- Enforces strict schema validation using Zod.
- Integrates Express REST API routing layers.
`;
  writeFileSync(join(tempDir, 'README.md'), readmeContent, 'utf8');

  await t.test('1. Extracts facts from package.json and README.md into project namespace', async () => {
    process.env.PERSYST_PROJECT = 'test-app-service';

    const result = await autoRepoIngest(tempDir);
    assert.equal(result.success, true, 'autoRepoIngest should return success');
    assert.ok(result.added_count > 0, 'Should extract facts from package.json and README.md');

    // Retrieve memories
    const memories = getRecentMemories(50, 'test-app-service');
    const contents = memories.map(m => m.content);

    assert.ok(contents.some(c => c.includes('PROJECT SCOPE: test-app-service')), 'Should contain package.json project overview with PROJECT SCOPE prefix');
    assert.ok(contents.some(c => c.includes('STACK: Built with')), 'Should contain detected tech stack with STACK prefix');
    assert.ok(contents.some(c => c.includes('Test App Microservice Architecture')), 'Should contain README title architecture feature');
    assert.ok(contents.some(c => c.includes('Built with SQLite for zero-latency local caching')), 'Should contain README guideline bullet point');
  });

  await t.test('2. Deduplicates subsequent runs so no duplicate facts are inserted', async () => {
    process.env.PERSYST_PROJECT = 'test-app-service';

    const result = await autoRepoIngest(tempDir);
    assert.equal(result.success, true);
    assert.equal(result.added_count, 0, 'Second run should add 0 facts due to deduplication');
  });

  // Cleanup
  rmSync(tempDir, { recursive: true, force: true });
  closeDatabase();
});
