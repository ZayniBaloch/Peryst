#!/usr/bin/env node

process.env.NODE_ENV = 'test';
process.env.SCOPEKEEP_WORKSPACE_ROOT = process.cwd();

const { collectStatus } = await import('../bin/diagnostics.js');
const { WORKSPACE_ID, closeDatabase } = await import('../src/database.js');

try {
  const status = collectStatus();
  if (status.workspace_id !== WORKSPACE_ID) throw new Error('workspace ID mismatch');
  if (status.database !== ':memory:') throw new Error('tests must use an in-memory database');
  if (status.capture !== 'off') throw new Error('capture must default to off');
  if (status.http_gateway !== 'off') throw new Error('HTTP gateway must default to off');
  if (!Number.isInteger(status.memories.active)) throw new Error('memory count must be numeric');
  console.log('ScopeKeep diagnostics status checks passed.');
} finally {
  closeDatabase();
}
