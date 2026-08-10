import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(import.meta.dirname, '..');

function runDatabaseProcess(source, env) {
  return spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: projectRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

test('workspace database is encrypted and reopens with the configured key', () => {
  const directory = mkdtempSync(join(tmpdir(), 'scopekeep-encryption-'));
  const databasePath = join(directory, 'scopekeep.db');
  const env = {
    NODE_ENV: 'test',
    SCOPEKEEP_FORCE_DB_ENCRYPTION: '1',
    SCOPEKEEP_DB: databasePath,
    SCOPEKEEP_DB_KEY: 'test-only-scopekeep-encryption-key-2026',
    SCOPEKEEP_WORKSPACE_ROOT: projectRoot
  };

  try {
    const write = runDatabaseProcess(`
      import { insertMemory, closeDatabase } from './src/database.js';
      insertMemory('encrypted regression memory');
      closeDatabase();
    `, env);
    assert.equal(write.status, 0, write.stderr || write.stdout);

    const header = readFileSync(databasePath).subarray(0, 16).toString('binary');
    assert.notEqual(header, 'SQLite format 3\0', 'database file must not expose the SQLite plaintext header');

    const read = runDatabaseProcess(`
      import db, { closeDatabase, WORKSPACE_ID } from './src/database.js';
      const row = db.prepare('SELECT content FROM memories WHERE workspace_id = ?').get(WORKSPACE_ID);
      process.stdout.write(row?.content || '');
      closeDatabase();
    `, env);
    assert.equal(read.status, 0, read.stderr || read.stdout);
    assert.match(read.stdout, /encrypted regression memory/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
