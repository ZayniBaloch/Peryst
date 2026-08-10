#!/usr/bin/env node

process.env.NODE_ENV = 'test';
process.env.SCOPEKEEP_WORKSPACE_ROOT = process.cwd();

const {
  WORKSPACE_ID,
  insertMemory,
  insertVector,
  insertEntity,
  exportWorkspaceData,
  purgeWorkspaceData,
  closeDatabase,
  default: db
} = await import('../src/database.js');

let failures = 0;

function assert(condition, message) {
  if (!condition) {
    failures += 1;
    console.error(`FAIL: ${message}`);
  } else {
    console.log(`PASS: ${message}`);
  }
}

try {
  const memoryId = insertMemory(
    'A privacy export must include this workspace-scoped memory.',
    0.9,
    { source_type: 'manual', confidence: 1 },
    'shared'
  );
  insertVector(memoryId, new Float32Array(384));
  insertEntity('PrivacyControl', 'component');
  db.prepare(`
    INSERT INTO watched_files (file_path, last_position, workspace_id)
    VALUES (?, ?, ?)
  `).run('transcript.jsonl', 42, WORKSPACE_ID);

  const exported = exportWorkspaceData();
  assert(exported.format === 'scopekeep-workspace-export', 'export has a versioned ScopeKeep format');
  assert(exported.workspace_id === WORKSPACE_ID, 'export is bound to the active workspace');
  assert(exported.records.memories.some(row => row.id === memoryId), 'export contains workspace memories');
  assert(exported.records.provenance.some(row => row.memory_id === memoryId), 'export contains memory provenance');
  assert(exported.records.entities.length === 1, 'export contains graph entities');
  assert(exported.records.watched_files.length === 1, 'export contains watcher offsets');
  assert(exported.records.vectors.length === 1, 'export contains derived vector data');

  const result = purgeWorkspaceData({ vacuum: false });
  assert(result.verified === true, 'purge performs post-delete verification');
  assert(Object.values(result.after).every(count => count === 0), 'all workspace-owned records are deleted');
  assert(exportWorkspaceData().counts.memories === 0, 'post-purge export contains no memories');
} catch (error) {
  failures += 1;
  console.error(`FAIL: unexpected error: ${error.stack || error.message}`);
} finally {
  closeDatabase();
}

if (failures > 0) {
  console.error(`\n${failures} privacy control assertion(s) failed.`);
  process.exit(1);
}

console.log('\nPrivacy controls verified.');
