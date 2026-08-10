process.env.NODE_ENV = 'test';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { updateWorkspaceRules } from '../src/rules-updater.js';
import { insertMemory, insertVector, closeDatabase } from '../src/database.js';
import { generateEmbedding } from '../src/embeddings.js';

test('Workspace Rules Updater', async (t) => {
  // Setup temp directory
  const tempDir = mkdtempSync(join(tmpdir(), 'persyst-test-rules-'));
  
  // Seed the test database with memory
  const testText = 'Rule: Always use camelCase for variables';
  const memId = insertMemory(testText, 1.0, null, 'persyst-test-rules');
  const embedding = await generateEmbedding(testText);
  insertVector(memId, embedding);

  // Define paths
  const cursorrulesPath = join(tempDir, '.cursorrules');
  const agentsDir = join(tempDir, '.agents');
  mkdirSync(agentsDir, { recursive: true });
  const agentsRulesPath = join(agentsDir, 'AGENTS.md');

  const cursorRulesDir = join(tempDir, '.cursor', 'rules');
  mkdirSync(cursorRulesDir, { recursive: true });
  const cursorMdcPath = join(cursorRulesDir, 'persyst.mdc');

  const githubDir = join(tempDir, '.github');
  mkdirSync(githubDir, { recursive: true });
  const copilotPath = join(githubDir, 'copilot-instructions.md');

  // Create initial files with text and markers
  const cursorrulesInitial = `
# Static Cursor Instructions
Always do x.
<!-- PERSYST_CONTEXT_START -->
<!-- PERSYST_CONTEXT_END -->
Footer instruction here.
`;
  writeFileSync(cursorrulesPath, cursorrulesInitial, 'utf8');

  const agentsRulesInitial = `
# Static Gemini Instructions
Always do y.
<!-- PERSYST_CONTEXT_START -->
<!-- PERSYST_CONTEXT_END -->
`;
  writeFileSync(agentsRulesPath, agentsRulesInitial, 'utf8');

  const mdcInitial = `---
description: Test
globs: *
alwaysApply: true
---
<!-- PERSYST_CONTEXT_START -->
<!-- PERSYST_CONTEXT_END -->
`;
  writeFileSync(cursorMdcPath, mdcInitial, 'utf8');

  const copilotInitial = `
# Copilot Instructions
<!-- PERSYST_CONTEXT_START -->
<!-- PERSYST_CONTEXT_END -->
`;
  writeFileSync(copilotPath, copilotInitial, 'utf8');

  // Verify updates
  await t.test('1. Inject context between markers in rule files', async () => {
    // Override PERSYST_PROJECT environment to match database seed namespace
    process.env.PERSYST_PROJECT = 'persyst-test-rules';
    
    const result = await updateWorkspaceRules(tempDir);
    assert.equal(result.success, true, 'Should successfully complete rule updates');
    assert.equal(result.updated_files, 4, 'Should update exactly 4 rule files');

    // Read back and assert
    const cursorrulesUpdated = readFileSync(cursorrulesPath, 'utf8');
    assert.ok(cursorrulesUpdated.includes('### repoMemory'), 'Should contain the 3-tier repoMemory section title');
    assert.ok(cursorrulesUpdated.includes('Rule: Always use camelCase for variables'), 'Should contain the seeded memory');
    assert.ok(cursorrulesUpdated.includes('# Static Cursor Instructions'), 'Should preserve static content before marker');
    assert.ok(cursorrulesUpdated.includes('Footer instruction here.'), 'Should preserve static content after marker');

    const agentsRulesUpdated = readFileSync(agentsRulesPath, 'utf8');
    assert.ok(agentsRulesUpdated.includes('Rule: Always use camelCase for variables'), 'Should contain memory in AGENTS.md');
    assert.ok(agentsRulesUpdated.includes('# Static Gemini Instructions'), 'Should preserve static content in AGENTS.md');

    const mdcUpdated = readFileSync(cursorMdcPath, 'utf8');
    assert.ok(mdcUpdated.includes('alwaysApply: true'), 'Should contain Cursor MDC alwaysApply: true');
    assert.ok(mdcUpdated.includes('Rule: Always use camelCase for variables'), 'Should contain memory in persyst.mdc');

    const copilotUpdated = readFileSync(copilotPath, 'utf8');
    assert.ok(copilotUpdated.includes('Rule: Always use camelCase for variables'), 'Should contain memory in copilot-instructions.md');
  });

  await t.test('2. Handle files with missing markers gracefully', async () => {
    const brokenFilePath = join(tempDir, '.windsurfrules');
    writeFileSync(brokenFilePath, 'No markers here!', 'utf8');

    const result = await updateWorkspaceRules(tempDir);
    assert.equal(result.success, true);
    
    // Windsurfrules should remain completely untouched
    const windsurfContent = readFileSync(brokenFilePath, 'utf8');
    assert.equal(windsurfContent, 'No markers here!');
  });

  // Cleanup
  rmSync(tempDir, { recursive: true, force: true });
  closeDatabase();
});
