/**
 * database.js — SQLite Database Setup & CRUD Operations
 * 
 * This file handles everything database-related:
 * - Opens SQLite connection at ~/.persyst/persyst.db
 * - Loads the sqlite-vec extension for vector search
 * - Creates all tables (memories, FTS5 index, vector index)
 * - Runs schema migrations for production-grade bi-temporal model
 * - Exports simple CRUD functions for other modules to use
 * 
 * IMPORTANT: better-sqlite3 is SYNCHRONOUS. No async/await here.
 */

import Database from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';
import { compressFact } from './summarizer.js';
import { dirname, join, resolve } from 'path';
import { homedir } from 'os';
import { chmodSync, mkdirSync, readFileSync, realpathSync, existsSync, statSync, writeFileSync } from 'fs';
import { createHash, randomBytes } from 'crypto';

import { logInfo } from './text-utils.js';
import { EMBED_DIM } from './embeddings.js';

// ============================================================
// DATABASE LOCATION
// Store in ~/.scopekeep/ per default to persist across sessions
// ============================================================

const DB_DIR = join(homedir(), '.scopekeep');
mkdirSync(DB_DIR, { recursive: true });

function canonicalizeWorkspaceRoot(inputPath) {
  const resolved = resolve(inputPath || process.cwd());
  let canonical = resolved;
  try { canonical = realpathSync.native(resolved); } catch (_) { /* The configured path may not exist yet. */ }
  canonical = canonical.replace(/\\/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

export const WORKSPACE_ROOT = canonicalizeWorkspaceRoot(
  process.env.SCOPEKEEP_WORKSPACE_ROOT || process.env.PERSYST_WORKSPACE_ROOT || process.env.PERSYST_PROJECT_ROOT || process.cwd()
);
export const WORKSPACE_ID = process.env.SCOPEKEEP_WORKSPACE_ID || process.env.PERSYST_WORKSPACE_ID ||
  `ws_${createHash('sha256').update(WORKSPACE_ROOT).digest('hex').slice(0, 20)}`;

export function getWorkspaceDatabasePath(workspaceId = WORKSPACE_ID) {
  const wsDir = join(DB_DIR, 'workspaces', workspaceId);
  mkdirSync(wsDir, { recursive: true });
  return join(wsDir, 'scopekeep.db');
}

function accessNamespaces(namespace = null) {
  if (namespace === 'all') {
    throw new Error('The "all" namespace is disabled. Use an explicit workspace administration flow.');
  }
  const values = new Set(['shared']);
  if (process.env.PERSYST_PROJECT) values.add(process.env.PERSYST_PROJECT.toLowerCase());
  if (namespace) {
    for (const value of String(namespace).split(',')) {
      const normalized = value.trim().toLowerCase();
      if (normalized && normalized !== 'all') values.add(normalized);
    }
  }
  return Array.from(values);
}

function accessPair(namespace = null) {
  const values = accessNamespaces(namespace).filter(value => value !== 'shared');
  return [values[0] || 'shared', values[1] || values[0] || 'shared'];
}
const isTestEnv = process.env.NODE_ENV === 'test' || 
                  process.argv.some(a => a.includes('test')) || 
                  (process.mainModule && process.mainModule.filename && process.mainModule.filename.includes('test'));
const forceEncryptedTestDatabase = process.env.SCOPEKEEP_FORCE_DB_ENCRYPTION === '1';

function getActiveDatabasePath() {
  if (isTestEnv && !forceEncryptedTestDatabase) return ':memory:';
  if (process.env.SCOPEKEEP_DB) return process.env.SCOPEKEEP_DB;
  if (process.env.PERSYST_DB) return process.env.PERSYST_DB;

  // ScopeKeep 3 uses a physically separate database per canonical workspace.
  // Legacy shared databases remain available only through explicit migration opt-in.
  if (process.env.SCOPEKEEP_USE_LEGACY_DB !== '1') {
    return getWorkspaceDatabasePath(WORKSPACE_ID);
  }

  const scopekeepPath = join(DB_DIR, 'scopekeep.db');
  const legacyScopekeepPersystPath = join(DB_DIR, 'persyst.db');
  const legacyPersystPath = join(homedir(), '.persyst', 'persyst.db');

  if (existsSync(legacyPersystPath)) {
    try {
      const legacyStat = statSync(legacyPersystPath);
      if (legacyStat.size > 0) {
        if (!existsSync(scopekeepPath)) {
          return legacyPersystPath;
        }
        const scopeStat = statSync(scopekeepPath);
        if (legacyStat.size > scopeStat.size) {
          return legacyPersystPath;
        }
      }
    } catch (_) {}
  }
  if (existsSync(legacyScopekeepPersystPath)) {
    return legacyScopekeepPersystPath;
  }
  return scopekeepPath;
}

export const ACTIVE_DATABASE_PATH = getActiveDatabasePath();
const DB_PATH = ACTIVE_DATABASE_PATH;

const DATABASE_ENCRYPTION_ENABLED = (!isTestEnv || forceEncryptedTestDatabase) &&
  process.env.SCOPEKEEP_DISABLE_DB_ENCRYPTION !== '1' &&
  DB_PATH !== ':memory:';

function getDatabaseKey() {
  if (!DATABASE_ENCRYPTION_ENABLED) return null;

  const configured = process.env.SCOPEKEEP_DB_KEY;
  if (configured) {
    if (configured.length < 16) {
      throw new Error('SCOPEKEEP_DB_KEY must contain at least 16 characters.');
    }
    return createHash('sha256').update(configured).digest('hex');
  }

  const keyPath = process.env.SCOPEKEEP_DB_KEY_FILE || join(dirname(DB_PATH), 'scopekeep.key');
  if (!existsSync(keyPath)) {
    mkdirSync(dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, `${randomBytes(32).toString('hex')}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    });
  }
  try { chmodSync(keyPath, 0o600); } catch (_) { /* Windows ACLs remain controlled by the user profile. */ }
  const material = readFileSync(keyPath, 'utf8').trim();
  if (material.length < 32) {
    throw new Error(`ScopeKeep database key file is invalid: ${keyPath}`);
  }
  return createHash('sha256').update(material).digest('hex');
}

function isPlaintextSqlite(path) {
  if (!existsSync(path) || statSync(path).size < 16) return false;
  const header = readFileSync(path).subarray(0, 16).toString('binary');
  return header === 'SQLite format 3\u0000';
}

function openDatabase(path) {
  const key = getDatabaseKey();
  const plaintext = DATABASE_ENCRYPTION_ENABLED && isPlaintextSqlite(path);
  let connection = new Database(path);

  if (!key) return connection;

  if (plaintext) {
    try { connection.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
    connection.pragma('journal_mode = DELETE');
    connection.pragma(`rekey='${key}'`);
    connection.close();
    connection = new Database(path);
    logInfo('[scopekeep] Existing workspace database encrypted at rest.');
  }

  connection.pragma(`key='${key}'`);
  connection.prepare('SELECT count(*) AS count FROM sqlite_master').get();
  return connection;
}

export const DATABASE_ENCRYPTION_STATUS = Object.freeze({
  enabled: DATABASE_ENCRYPTION_ENABLED,
  key_source: process.env.SCOPEKEEP_DB_KEY ? 'environment' :
    (process.env.SCOPEKEEP_DB_KEY_FILE ? 'configured-file' : 'workspace-key-file')
});

// ============================================================
// INITIALIZE CONNECTION
// ============================================================

const db = openDatabase(DB_PATH);
db.pragma('journal_mode = WAL');   // Better performance for concurrent reads
db.pragma('foreign_keys = ON');    // Enforce referential integrity
db.pragma('secure_delete = ON');   // Overwrite deleted content before pages are reused
db.pragma('mmap_size = 268435456'); // 256MB memory-mapped I/O for faster reads
db.pragma('synchronous = NORMAL');  // Performance boost for WAL mode
db.pragma('temp_store = MEMORY');   // Keep temp tables in memory
db.pragma('cache_size = -64000');   // 64MB cache size

// Load sqlite-vec BEFORE creating any vec0 tables
sqliteVec.load(db);

logInfo(`[scopekeep] Database: ${DB_PATH}`);
logInfo(`[scopekeep] Workspace boundary: ${WORKSPACE_ID}`);

// ============================================================
// CREATE TABLES & SCHEMA MIGRATIONS
// ============================================================

// --- Main memories table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id              INTEGER PRIMARY KEY,
    content         TEXT    NOT NULL,
    importance_score REAL   DEFAULT 1.0,
    created_at      INTEGER DEFAULT (unixepoch()),
    last_accessed   INTEGER DEFAULT (unixepoch()),
    access_count    INTEGER DEFAULT 0,
    valid_from      INTEGER DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)),
    valid_until     INTEGER DEFAULT NULL,
    assertion_time  INTEGER DEFAULT (CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))
  )
`);

// --- Migrations for bi-temporal validity on existing tables ---
function columnExists(table, name) {
  const info = db.prepare(`PRAGMA table_info(${table})`).all();
  return info.some(col => col.name === name);
}

if (!columnExists('memories', 'valid_from')) {
  db.exec('ALTER TABLE memories ADD COLUMN valid_from INTEGER DEFAULT (unixepoch())');
}

if (!columnExists('memories', 'valid_until')) {
  db.exec('ALTER TABLE memories ADD COLUMN valid_until INTEGER DEFAULT NULL');
}

if (!columnExists('memories', 'assertion_time')) {
  db.exec('ALTER TABLE memories ADD COLUMN assertion_time INTEGER DEFAULT (unixepoch())');
}

// ScopeKeep 3.0 uses millisecond precision so rapid consecutive updates have
// an unambiguous validity boundary. Older databases stored these fields in
// Unix seconds; migrate only values that are clearly second-based.
db.exec(`
  UPDATE memories SET valid_from = valid_from * 1000
  WHERE valid_from IS NOT NULL AND valid_from < 100000000000;
  UPDATE memories SET valid_until = valid_until * 1000
  WHERE valid_until IS NOT NULL AND valid_until < 100000000000;
  UPDATE memories SET assertion_time = assertion_time * 1000
  WHERE assertion_time IS NOT NULL AND assertion_time < 100000000000;
`);

if (!columnExists('memories', 'summary')) {
  db.exec('ALTER TABLE memories ADD COLUMN summary TEXT DEFAULT NULL');
}

if (!columnExists('memories', 'parent_id')) {
  db.exec('ALTER TABLE memories ADD COLUMN parent_id INTEGER DEFAULT NULL');
}

if (!columnExists('memories', 'hierarchy_level')) {
  db.exec('ALTER TABLE memories ADD COLUMN hierarchy_level INTEGER DEFAULT 3');
}

// --- Migration: add namespace column for per-agent isolation ---
if (!columnExists('memories', 'namespace')) {
  db.exec("ALTER TABLE memories ADD COLUMN namespace TEXT DEFAULT 'shared'");
}

if (!columnExists('memories', 'workspace_id')) {
  db.exec("ALTER TABLE memories ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'legacy-unscoped'");
  logInfo('[scopekeep] Existing unscoped memories were quarantined as legacy-unscoped.');
}

// --- Migration: add parent_id column for history tracing ---
if (!columnExists('memories', 'parent_id')) {
  db.exec('ALTER TABLE memories ADD COLUMN parent_id INTEGER DEFAULT NULL');
}

// --- Index on namespace for fast filtered queries ---
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_workspace_namespace ON memories (workspace_id, namespace, valid_until)');
} catch (e) { /* Index already exists */ }

// --- Contradictions table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS contradictions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    old_memory_id     INTEGER NOT NULL,
    new_memory_id     INTEGER NOT NULL,
    resolved_at       INTEGER DEFAULT (unixepoch()),
    resolution_reason TEXT
  )
`);

// --- Provenance table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS provenance (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    memory_id   INTEGER NOT NULL,
    source_type TEXT NOT NULL, -- agent | git | manual | api
    source_id   TEXT,          -- agent name or git hash
    created_at  INTEGER DEFAULT (unixepoch()),
    confidence  REAL NOT NULL
  )
`);

// --- Agent Stats table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_stats (
    agent_id              TEXT NOT NULL,
    memories_created      INTEGER DEFAULT 0,
    memories_confirmed    INTEGER DEFAULT 0,
    memories_contradicted INTEGER DEFAULT 0,
    reputation_score      REAL DEFAULT 1.0,
    last_active           INTEGER DEFAULT (unixepoch()),
    workspace_id          TEXT NOT NULL,
    PRIMARY KEY(workspace_id, agent_id)
  )
`);

if (!columnExists('agent_stats', 'workspace_id')) {
  db.exec(`
    ALTER TABLE agent_stats RENAME TO agent_stats_legacy;
    CREATE TABLE agent_stats (
      agent_id TEXT NOT NULL,
      memories_created INTEGER DEFAULT 0,
      memories_confirmed INTEGER DEFAULT 0,
      memories_contradicted INTEGER DEFAULT 0,
      reputation_score REAL DEFAULT 1.0,
      last_active INTEGER DEFAULT (unixepoch()),
      domain TEXT DEFAULT 'general',
      workspace_id TEXT NOT NULL,
      PRIMARY KEY(workspace_id, agent_id)
    );
    INSERT INTO agent_stats (
      agent_id, memories_created, memories_confirmed, memories_contradicted,
      reputation_score, last_active, domain, workspace_id
    ) SELECT agent_id, memories_created, memories_confirmed, memories_contradicted,
      reputation_score, last_active, COALESCE(domain, 'general'), 'legacy-unscoped'
      FROM agent_stats_legacy;
    DROP TABLE agent_stats_legacy;
  `);
}

// --- Migration: add domain column to agent_stats ---
try {
  db.exec('ALTER TABLE agent_stats ADD COLUMN domain TEXT DEFAULT "general"');
} catch (e) { /* Column already exists */ }

// --- Attestations table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS attestations (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    attestation_id     TEXT NOT NULL UNIQUE,
    query              TEXT NOT NULL,
    timestamp          TEXT NOT NULL,
    memories_retrieved TEXT NOT NULL,
    agent_id           TEXT,
    session_id         TEXT,
    signature          TEXT NOT NULL,
    previous_hash      TEXT,
    hash               TEXT NOT NULL,
    workspace_id       TEXT NOT NULL
  )
`);

if (!columnExists('attestations', 'workspace_id')) {
  db.exec("ALTER TABLE attestations ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'legacy-unscoped'");
}

// --- Schema version table (tracks migrations) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

// --- Migration: enable porter stemming in FTS5 tokenizer ---
const currentTokenizer = db.prepare("SELECT value FROM schema_meta WHERE key = 'fts_tokenizer'").get();
if (!currentTokenizer || currentTokenizer.value !== 'porter_unicode61') {
  logInfo('[scopekeep] Migrating FTS5 tokenizer to porter + unicode61...');
  db.exec('DROP TRIGGER IF EXISTS memories_fts_insert');
  db.exec('DROP TRIGGER IF EXISTS memories_fts_delete');
  db.exec('DROP TRIGGER IF EXISTS memories_fts_update');
  db.exec('DROP TABLE IF EXISTS memories_fts');

  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content='memories',
      content_rowid='id',
      tokenize='porter unicode61 remove_diacritics 2'
    )
  `);

  db.exec(`
    CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories
    BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END
  `);
  db.exec(`
    CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories
    BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content)
      VALUES ('delete', old.id, old.content);
    END
  `);
  db.exec(`
    CREATE TRIGGER memories_fts_update AFTER UPDATE OF content ON memories
    BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content)
      VALUES ('delete', old.id, old.content);
      INSERT INTO memories_fts(rowid, content)
      VALUES (new.id, new.content);
    END
  `);

  try {
    db.exec("INSERT INTO memories_fts(rowid, content) SELECT id, content FROM memories WHERE valid_until IS NULL");
    logInfo('[scopekeep] FTS5 index rebuilt with porter stemming.');
  } catch (e) {
    console.error('[scopekeep] FTS5 rebuild error:', e.message);
  }

  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('fts_tokenizer', 'porter_unicode61')").run();
}

// --- Vector table for semantic search (384-dim embeddings) ---
const vecDim = db.prepare("SELECT value FROM schema_meta WHERE key = 'vec_dimension'").get();
if (!vecDim || Number(vecDim.value) !== EMBED_DIM) {
  logInfo(`[scopekeep] Migrating vector dimension from ${vecDim ? vecDim.value : 'unset'} to ${EMBED_DIM}...`);
  db.exec('DROP TABLE IF EXISTS memories_vec');
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
      embedding float[${EMBED_DIM}]
    )
  `);
  db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES ('vec_dimension', ?)").run(String(EMBED_DIM));
  logInfo('[scopekeep] Vector table rebuilt with new dimension. Old vectors discarded — will regenerate on next insert.');
} else {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
      embedding float[${EMBED_DIM}]
    )
  `);
}

// --- Knowledge Graph: entities + edges ---
db.exec(`
  CREATE TABLE IF NOT EXISTS entities (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()),
    workspace_id TEXT NOT NULL,
    UNIQUE(workspace_id, name, type)
  )
`);

if (!columnExists('entities', 'workspace_id')) {
  db.exec(`
    ALTER TABLE entities RENAME TO entities_legacy;
    CREATE TABLE entities (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      workspace_id TEXT NOT NULL,
      UNIQUE(workspace_id, name, type)
    );
    INSERT INTO entities (id, name, type, created_at, workspace_id)
      SELECT id, name, type, created_at, 'legacy-unscoped' FROM entities_legacy;
    DROP TABLE entities_legacy;
  `);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS edges (
    id          INTEGER PRIMARY KEY,
    source_id   INTEGER NOT NULL,
    target_id   INTEGER NOT NULL,
    relation    TEXT NOT NULL,
    source_type TEXT NOT NULL,
    target_type TEXT NOT NULL,
    created_at  INTEGER DEFAULT (unixepoch()),
    workspace_id TEXT NOT NULL
  )
`);

if (!columnExists('edges', 'workspace_id')) {
  db.exec("ALTER TABLE edges ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'legacy-unscoped'");
}

db.exec(`
  CREATE TABLE IF NOT EXISTS watched_files (
    file_path     TEXT NOT NULL,
    last_position INTEGER NOT NULL,
    updated_at    INTEGER DEFAULT (unixepoch()),
    workspace_id  TEXT NOT NULL,
    PRIMARY KEY(workspace_id, file_path)
  )
`);

if (!columnExists('watched_files', 'workspace_id')) {
  db.exec(`
    ALTER TABLE watched_files RENAME TO watched_files_legacy;
    CREATE TABLE watched_files (
      file_path TEXT NOT NULL,
      last_position INTEGER NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch()),
      workspace_id TEXT NOT NULL,
      PRIMARY KEY(workspace_id, file_path)
    );
    INSERT INTO watched_files (file_path, last_position, updated_at, workspace_id)
      SELECT file_path, last_position, updated_at, 'legacy-unscoped' FROM watched_files_legacy;
    DROP TABLE watched_files_legacy;
  `);
}

logInfo('[scopekeep] Schema initialized ✓');

// ============================================================
// PREPARED STATEMENTS
// Pre-compile SQL for performance. better-sqlite3 is synchronous.
// ============================================================

const stmts = {
  // -- Insert --
  insertMemory: db.prepare(
    'INSERT INTO memories (content, summary, importance_score, namespace, parent_id, hierarchy_level, workspace_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ),
  insertVec: db.prepare(
    'INSERT OR REPLACE INTO memories_vec (rowid, embedding) VALUES (?, ?)'
  ),
  insertProvenance: db.prepare(
    'INSERT INTO provenance (memory_id, source_type, source_id, confidence) VALUES (?, ?, ?, ?)'
  ),
  insertContradiction: db.prepare(
    'INSERT INTO contradictions (old_memory_id, new_memory_id, resolution_reason) VALUES (?, ?, ?)'
  ),
  upsertAgent: db.prepare(`
    INSERT INTO agent_stats (agent_id, workspace_id) VALUES (?, ?)
    ON CONFLICT(workspace_id, agent_id) DO UPDATE SET last_active = unixepoch()
  `),
  incrementCreated: db.prepare(
    'UPDATE agent_stats SET memories_created = memories_created + 1 WHERE agent_id = ? AND workspace_id = ?'
  ),
  incrementConfirmed: db.prepare(
    'UPDATE agent_stats SET memories_confirmed = memories_confirmed + 1 WHERE agent_id = ? AND workspace_id = ?'
  ),
  incrementContradicted: db.prepare(
    'UPDATE agent_stats SET memories_contradicted = memories_contradicted + 1 WHERE agent_id = ? AND workspace_id = ?'
  ),
  recalculateReputation: db.prepare(
    'UPDATE agent_stats SET reputation_score = MIN(1.0, (memories_confirmed + 1.0) / (memories_contradicted + 1.0)) WHERE agent_id = ? AND workspace_id = ?'
  ),
  insertAttestation: db.prepare(`
    INSERT INTO attestations (
      attestation_id, query, timestamp, memories_retrieved,
      agent_id, session_id, signature, previous_hash, hash, workspace_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  // -- Read --
  getById: db.prepare(
    'SELECT * FROM memories WHERE id = ? AND workspace_id = ? AND valid_until IS NULL'
  ),
  getByIdNs: db.prepare(
    "SELECT * FROM memories WHERE id = ? AND workspace_id = ? AND (namespace = ? OR namespace = ? OR namespace = 'shared') AND valid_until IS NULL"
  ),
  getAnyById: db.prepare(
    'SELECT * FROM memories WHERE id = ? AND workspace_id = ?'
  ),
  getRecent: db.prepare(
    'SELECT * FROM memories WHERE workspace_id = ? AND valid_until IS NULL ORDER BY created_at DESC LIMIT ?'
  ),
  getRecentNs: db.prepare(
    "SELECT * FROM memories WHERE workspace_id = ? AND (namespace = ? OR namespace = ? OR namespace = 'shared') AND valid_until IS NULL ORDER BY created_at DESC LIMIT ?"
  ),
  getImportant: db.prepare(
    'SELECT * FROM memories WHERE workspace_id = ? AND valid_until IS NULL ORDER BY importance_score DESC LIMIT ?'
  ),
  getImportantNs: db.prepare(
    "SELECT * FROM memories WHERE workspace_id = ? AND (namespace = ? OR namespace = ? OR namespace = 'shared') AND valid_until IS NULL ORDER BY importance_score DESC LIMIT ?"
  ),
  getAsOfNs: db.prepare(`
    SELECT * FROM memories
    WHERE workspace_id = ?
      AND (namespace = ? OR namespace = ? OR namespace = 'shared')
      AND valid_from <= ?
      AND (valid_until IS NULL OR valid_until > ?)
      AND assertion_time <= ?
    ORDER BY importance_score DESC, valid_from DESC, id DESC
    LIMIT ?
  `),
  getProvenance: db.prepare(
    'SELECT * FROM provenance WHERE memory_id = ? ORDER BY id DESC'
  ),
  getAllAgentStats: db.prepare(
    'SELECT * FROM agent_stats WHERE workspace_id = ? ORDER BY reputation_score DESC'
  ),
  getAttestation: db.prepare(
    'SELECT * FROM attestations WHERE attestation_id = ? AND workspace_id = ?'
  ),
  getLastAttestation: db.prepare(
    'SELECT * FROM attestations WHERE workspace_id = ? ORDER BY id DESC LIMIT 1'
  ),
  getAttestationsByDate: db.prepare(
    'SELECT * FROM attestations WHERE timestamp >= ? AND timestamp <= ? AND workspace_id = ? ORDER BY id ASC'
  ),

  // -- Update --
  updateContent: db.prepare(
    'UPDATE memories SET content = ? WHERE id = ? AND workspace_id = ?'
  ),
  updateTemporalStart: db.prepare(
    'UPDATE memories SET valid_from = ?, assertion_time = ? WHERE id = ? AND workspace_id = ?'
  ),
  archiveMemory: db.prepare(
    "UPDATE memories SET valid_until = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = ? AND workspace_id = ?"
  ),
  archiveMemoryAt: db.prepare(
    'UPDATE memories SET valid_until = ? WHERE id = ? AND workspace_id = ?'
  ),

  // -- Delete --
  deleteMemory: db.prepare(
    'DELETE FROM memories WHERE id = ? AND workspace_id = ?'
  ),
  deleteVec: db.prepare(
    'DELETE FROM memories_vec WHERE rowid = ?'
  ),

  // -- Memory Lifecycle --
  boost: db.prepare(`
    UPDATE memories
    SET access_count    = access_count + 1,
        importance_score = ROUND(MIN(importance_score + 0.1, 1.0), 4),
        last_accessed   = unixepoch()
    WHERE id = ? AND workspace_id = ?
  `),
  decay: db.prepare(`
    UPDATE memories
    SET importance_score = ROUND(MAX(importance_score * 0.95, 0.0), 4)
    WHERE workspace_id = ? AND (unixepoch() - last_accessed) > 604800
  `),

  // -- Search --
  searchFts: db.prepare(`
    SELECT memories_fts.rowid AS id, memories_fts.rank AS rank
    FROM memories_fts
    JOIN memories m ON m.id = memories_fts.rowid
    WHERE memories_fts MATCH ?
      AND m.workspace_id = ?
      AND (m.namespace = ? OR m.namespace = ? OR m.namespace = 'shared')
      AND m.valid_until IS NULL
    ORDER BY memories_fts.rank
    LIMIT ?
  `),
  searchVec: db.prepare(`
    SELECT memories_vec.rowid, memories_vec.distance
    FROM memories_vec
    JOIN memories m ON m.id = memories_vec.rowid
    WHERE memories_vec.embedding MATCH ?
      AND k = ?
      AND m.workspace_id = ?
      AND (m.namespace = ? OR m.namespace = ? OR m.namespace = 'shared')
      AND m.valid_until IS NULL
    LIMIT ?
  `),

  // -- Entity CRUD --
  insertEntity: db.prepare(
    'INSERT OR IGNORE INTO entities (name, type, workspace_id) VALUES (?, ?, ?)'
  ),
  getEntityByName: db.prepare(
    'SELECT * FROM entities WHERE name = ? AND workspace_id = ?'
  ),
  getEntityById: db.prepare(
    'SELECT * FROM entities WHERE id = ? AND workspace_id = ?'
  ),
  getAllEntities: db.prepare(
    'SELECT * FROM entities WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?'
  ),
  deleteEntity: db.prepare(
    'DELETE FROM entities WHERE id = ? AND workspace_id = ?'
  ),
  deleteEdgesByEntity: db.prepare(
    `DELETE FROM edges WHERE
     workspace_id = ? AND ((source_id = ? AND source_type = 'entity') OR
     (target_id = ? AND target_type = 'entity'))`
  ),

  // -- Edges --
  insertEdge: db.prepare(
    'INSERT INTO edges (source_id, target_id, relation, source_type, target_type, workspace_id) VALUES (?, ?, ?, ?, ?, ?)'
  ),
  getEdgesBySource: db.prepare(
    'SELECT * FROM edges WHERE source_id = ? AND source_type = ? AND workspace_id = ?'
  ),
  getEdgesByTarget: db.prepare(
    'SELECT * FROM edges WHERE target_id = ? AND target_type = ? AND workspace_id = ?'
  ),
  deleteEdgesByMemory: db.prepare(
    `DELETE FROM edges WHERE
     workspace_id = ? AND ((source_id = ? AND source_type = 'memory') OR
     (target_id = ? AND target_type = 'memory'))`
  ),

  // -- Dedup --
  findMemoryByContent: db.prepare(
    'SELECT id FROM memories WHERE content = ? AND workspace_id = ? AND valid_until IS NULL LIMIT 1'
  ),
  findMemoryByContentNs: db.prepare(
    "SELECT id FROM memories WHERE content = ? AND workspace_id = ? AND (namespace = ? OR namespace = ? OR namespace = 'shared') AND valid_until IS NULL LIMIT 1"
  ),

  // -- Hash-prefix lookup for git dedup (Bug 1 fix) --
  findMemoryByHashPrefix: db.prepare(
    'SELECT id FROM memories WHERE content LIKE ? AND workspace_id = ? AND valid_until IS NULL LIMIT 1'
  ),

  // -- Active memory count --
  getActiveMemoryCount: db.prepare(
    'SELECT COUNT(*) as count FROM memories WHERE workspace_id = ? AND valid_until IS NULL'
  ),
  getActiveMemoryCountNs: db.prepare(
    "SELECT COUNT(*) as count FROM memories WHERE workspace_id = ? AND (namespace = ? OR namespace = ? OR namespace = 'shared') AND valid_until IS NULL"
  ),

  // -- Namespace stats --
  getNamespaceStats: db.prepare(
    'SELECT namespace, COUNT(*) as count FROM memories WHERE workspace_id = ? AND valid_until IS NULL GROUP BY namespace ORDER BY count DESC'
  ),

  // -- Content size stats (exact character & token counts) --
  getContentStats: db.prepare(`
    SELECT
      COUNT(*)                      AS memory_count,
      COALESCE(SUM(LENGTH(content)), 0)  AS total_chars,
      COALESCE(AVG(LENGTH(content)), 0)  AS avg_chars,
      COALESCE(MAX(LENGTH(content)), 0)  AS max_chars,
      COALESCE(MIN(LENGTH(content)), 0)  AS min_chars
    FROM memories
    WHERE workspace_id = ? AND valid_until IS NULL
  `),

  // -- Namespace-level content stats --
  getNamespaceContentStats: db.prepare(`
    SELECT
      namespace,
      COUNT(*)                      AS count,
      COALESCE(SUM(LENGTH(content)), 0) AS total_chars
    FROM memories
    WHERE workspace_id = ? AND valid_until IS NULL
    GROUP BY namespace
    ORDER BY total_chars DESC
  `),

  // -- Memory History Chain (Feature 6: prepared statements) --
  getContradictionAncestors: db.prepare(
    'SELECT old_memory_id FROM contradictions WHERE new_memory_id = ?'
  ),
  getContradictionDescendants: db.prepare(
    'SELECT new_memory_id FROM contradictions WHERE old_memory_id = ?'
  ),

  // -- Watcher Offsets --
  getWatchPosition: db.prepare(
    'SELECT last_position FROM watched_files WHERE file_path = ? AND workspace_id = ?'
  ),
  upsertWatchPosition: db.prepare(`
    INSERT INTO watched_files (file_path, last_position, workspace_id)
    VALUES (?, ?, ?)
    ON CONFLICT(workspace_id, file_path) DO UPDATE SET last_position = excluded.last_position, updated_at = unixepoch()
  `),

  // -- Internal lookups (pre-compiled for hot-loop use) --
  getAttestationByHash: db.prepare(
    'SELECT * FROM attestations WHERE hash = ? AND workspace_id = ?'
  ),
  getMemoryParentId: db.prepare(
    'SELECT parent_id FROM memories WHERE id = ? AND workspace_id = ?'
  ),
  getMemoryChildren: db.prepare(
    'SELECT id FROM memories WHERE parent_id = ? AND workspace_id = ?'
  ),
  getMemoryContentById: db.prepare(
    'SELECT content FROM memories WHERE id = ? AND workspace_id = ?'
  ),
  getMemoryByIdRaw: db.prepare(
    'SELECT * FROM memories WHERE id = ? AND workspace_id = ? AND valid_until IS NULL'
  ),
  getMemoryLikeContent: db.prepare(
    'SELECT id FROM memories WHERE content LIKE ? AND workspace_id = ? AND valid_until IS NULL'
  ),
  getVecByRowId: db.prepare(
    'SELECT embedding FROM memories_vec WHERE rowid = ?'
  ),
  updateMemoryParentId: db.prepare(
    'UPDATE memories SET parent_id = ? WHERE id = ? AND workspace_id = ?'
  ),
  deleteProvenanceByMemoryId: db.prepare(
    'DELETE FROM provenance WHERE memory_id = ?'
  ),
  deleteContradictionsByMemoryId: db.prepare(
    'DELETE FROM contradictions WHERE old_memory_id = ? OR new_memory_id = ?'
  ),
  getReputationScore: db.prepare(
    'SELECT reputation_score FROM agent_stats WHERE agent_id = ? AND workspace_id = ?'
  ),
  updateProvenanceOwner: db.prepare(
    "UPDATE provenance SET source_type = 'agent', source_id = ?, confidence = 1.0 WHERE memory_id = ?"
  ),
  archiveMemoryById: db.prepare(
    "UPDATE memories SET valid_until = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = ? AND workspace_id = ?"
  ),
  getEdgesBySourceAndType: db.prepare(`
    SELECT * FROM edges
    WHERE workspace_id = ? AND ((source_id = ? AND source_type = ?)
       OR (target_id = ? AND target_type = ?))
  `),
  getMemoriesByEntityEdges: db.prepare(`
    SELECT * FROM edges
    WHERE workspace_id = ? AND ((source_id = ? AND source_type = 'entity' AND target_type = 'memory')
       OR (target_id = ? AND target_type = 'entity' AND source_type = 'memory'))
  `),
  consolidateVecSearch: db.prepare(`
    SELECT rowid AS id, distance
    FROM memories_vec
    WHERE embedding MATCH ?
    AND k = 30
  `),
  archiveAndInsertContradiction: db.prepare(
    "UPDATE memories SET valid_until = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) WHERE id = ?"
  ),
  archiveExpiredTransientMemories: db.prepare(`
    UPDATE memories 
    SET valid_until = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
    WHERE workspace_id = ? AND valid_until IS NULL 
      AND (content LIKE 'Reminder:%' OR content LIKE 'Note:%') 
      AND (unixepoch() - created_at) > 1209600
  `)
};

export { stmts };

// ============================================================
// SECRET DETECTION & REDACTION HELPERS
// ============================================================

/**
 * Detects sensitive/credential patterns in a string and replaces values with [REDACTED].
 * @param {string} content - The content to sanitize
 * @returns {string} Sanitized content
 */
export function redactSecrets(content) {
  if (!content || typeof content !== 'string') return content;

  let redacted = content;

  // 1. Redact credentials in connection strings / URIs
  // Matches scheme://user:pass@host and scheme://:pass@host
  const connectionStringRegex = /\b([a-zA-Z0-9+.-]+:\/\/)([^/:\s]*):([^@/:\s]+)(@[^/\s]+)/gi;
  redacted = redacted.replace(connectionStringRegex, (match, protocol, user, pass, host) => {
    return protocol + user + ':[REDACTED]' + host;
  });

  // 2. Redact key-value pairs matching credentials (retaining key/operator, redacting value)
  // Supports single-quoted, double-quoted, and unquoted values (non-whitespace).
  const kvRegex = /['"]?\b(api[_-]?key|secret[_-]?key|secret|password|passwd|pwd|passphrase|auth[_-]?token|access[_-]?token|client[_-]?secret|private[_-]?key|auth|access|client|aws|gcp|google|stripe|github|openai|vercel|heroku|slack|ssh[_-]?(?:key|password|passphrase|pass)?|credential|aws_secret|secret_access_key|aws_access_key|ssh_passphrase|ssh_password|ssh_key_pass)\b['"]?\s*(?:key|token|secret|password|pwd|passwd|value|string|id)?(?:\b|(?<=['"]))\s*([:=]|is|of|to|set\s+to|\(|\buses\b)\s*(?:'([^']{6,2048})'|"([^"]{6,2048})"|([^\s]+(?:\n(?![a-zA-Z0-9_-]+\s*[:=])(?=[^\s]+(?:\n|$))[^\s]+)*))/gi;

  redacted = redacted.replace(kvRegex, (match, key, op, sqVal, dqVal, uqVal) => {
    const val = sqVal || dqVal || uqVal;
    if (!val) return match;

    // Strip trailing parenthesis if operator is '(' and value has trailing parenthesis
    let cleanVal = val;
    if (op === '(' && val.endsWith(')')) {
      cleanVal = val.slice(0, -1);
    }

    const lastIdx = match.lastIndexOf(cleanVal);
    if (lastIdx !== -1) {
      return match.slice(0, lastIdx) + '[REDACTED]' + match.slice(lastIdx + cleanVal.length);
    }
    return match;
  });

  // 3. Redact standalone common API keys and tokens
  const standalonePatterns = [
    /\b(sk-[a-zA-Z0-9]{48})\b/g, // OpenAI
    /\b(sk-proj-[a-zA-Z0-9-]{40,})\b/g, // OpenAI project
    /\b(gh[pous]_[a-zA-Z0-9]{36,255})\b/g, // GitHub PAT/Fine-grained
    /\b(xox[bapr]-[0-9]{12}-[a-zA-Z0-9]{24})\b/g, // Slack token
    /\b(AIzaSy[A-Za-z0-9_-]{33})\b/g, // Google API key
    /\b((?:sk|rk|pk)_(?:live|test)_[0-9a-zA-Z]{24,32})\b/g, // Stripe key
    /\b(AKIA[0-9A-Z]{16,40})\b/gi, // AWS Access Key ID (case-insensitive)
    /\b(ASCA[0-9A-Z]{16,40})\b/gi, // AWS ASCA Key
    /\b(npm_[a-zA-Z0-9]{36,255})\b/g, // npm token
    /\b(ey[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})\b/g, // JWT token
    /-----BEGIN[A-Z0-9\s_-]+PRIVATE\s+KEY[A-Z0-9\s_-]*-----\s*[\s\S]*?-----END[A-Z0-9\s_-]+PRIVATE\s+KEY[A-Z0-9\s_-]*-----/gi, // PEM private key
  ];

  for (const pattern of standalonePatterns) {
    redacted = redacted.replace(pattern, '[REDACTED]');
  }

  // 4. Robust credential shape heuristic (independent of strict key-value punctuation)
  const containsCredKeyword = /\b(password|passwd|pwd|passphrase|pass|secret|token|api|credential|auth|ssh|aws)\b/i.test(redacted);
  if (containsCredKeyword) {
    // Match password-like tokens: length 6 to 64, containing both letters and digits/symbols
    const tokenRegex = /\b([a-zA-Z0-9_@#$%^&*+!~\-]{6,64})(?!\w)/g;
    
    redacted = redacted.replace(tokenRegex, (match) => {
      // Skip common query words and technical keywords
      if (/^(password|passwd|pwd|passphrase|pass|secret|token|api|credential|auth|ssh|uses|with|key|from|here|what|have|this|that|your|same|then|want|more|base64|base64-like|base64-encoded|sha256|sha1|md5|aes256|aes128|utf8|utf-8|url|uri|ipv4|ipv6|http|https|sha-256|sha-1)$/i.test(match)) {
        return match;
      }
      
      const hasLetter = /[a-zA-Z]/.test(match);
      const hasDigitOrSpecialSymbol = /[0-9@#$%^&*+=!~]/.test(match);
      
      if (hasLetter && hasDigitOrSpecialSymbol) {
        // Require length >= 8 or containing special symbols/mixed case digits
        const isStrongSecretCandidate = match.length >= 8 || 
                                       (/[^a-zA-Z0-9_]/.test(match)) || 
                                       (/[A-Z]/.test(match) && /[0-9]/.test(match));
        
        if (isStrongSecretCandidate) {
          return '[REDACTED]';
        }
      }
      return match;
    });
  }

  return redacted;
}

// ============================================================
// CRUD FUNCTIONS
// Simple, one-purpose functions. No magic.
// ============================================================

/**
 * Insert a new memory into the memories table and log its provenance.
 * @param {string} content - Memory content
 * @param {number} importance - Importance score (0-1)
 * @param {Object} provenanceInfo - Provenance metadata
 * @param {string} namespace - Namespace for agent isolation (default: 'shared')
 * @returns {number} The new memory's ID
 */
export function insertMemory(content, importance = 1.0, provenanceInfo = null, namespace = 'shared', parentId = null, hierarchyLevel = 3) {
  const redactedContent = redactSecrets(content);
  if (redactedContent && redactedContent.length > 10000) {
    throw new Error('Memory content exceeds maximum length of 10000 characters.');
  }
  const summary = compressFact(redactedContent);
  const clampedImportance = Math.max(0.0, Math.min(1.0, Math.round(importance * 10000) / 10000));
  const normalizedNamespace = String(namespace || 'shared').trim().toLowerCase();
  if (normalizedNamespace === 'all') throw new Error('The "all" namespace cannot be stored.');
  const result = stmts.insertMemory.run(
    redactedContent,
    summary,
    clampedImportance,
    normalizedNamespace,
    parentId,
    hierarchyLevel || 3,
    WORKSPACE_ID
  );
  const id = Number(result.lastInsertRowid);

  // Provenance Info handling
  const source_type = provenanceInfo?.source_type || 'manual';
  let source_id = provenanceInfo?.source_id || null;
  if (source_type === 'agent' && source_id) {
    source_id = source_id.toLowerCase();
  }
  const confidence = provenanceInfo?.confidence !== undefined ? provenanceInfo.confidence : 1.0;

  stmts.insertProvenance.run(id, source_type, source_id, confidence);

  // Agent Stats handling
  if (source_type === 'agent' && source_id) {
    incrementAgentStat(source_id, 'created');
  }

  return id;
}

/**
 * Store an embedding vector for a memory.
 * @param {number} id - Memory ID (used as rowid in vec table)
 * @param {Float32Array} embedding - 384-dim embedding vector
 */
export function insertVector(id, embedding) {
  stmts.insertVec.run(BigInt(id), Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength));
}

/**
 * Find all memories that do not have a vector in the vector index.
 * @returns {Array<{id: number, content: string}>}
 */
export function getMemoriesMissingVectors() {
  return db.prepare(`
    SELECT id, content 
    FROM memories 
    WHERE id NOT IN (SELECT rowid FROM memories_vec) 
    AND workspace_id = ?
    AND valid_until IS NULL
  `).all(WORKSPACE_ID);
}

/**
 * Get a memory by ID. Boosts its importance on access.
 * @param {number} id - Memory ID
 * @param {string|null} namespace - Namespace filter (null = no filter)
 * @returns {object|null} The memory row, or null if not found
 */
export function getMemory(id, namespace = null) {
  const [first, second] = accessPair(namespace);
  const memory = stmts.getByIdNs.get(id, WORKSPACE_ID, first, second);
  if (memory) {
    boostMemory(id);
    memory.provenance = getProvenance(id);
  }
  return memory || null;
}

/**
 * Get a memory by ID WITHOUT boosting or checking bi-temporal validity.
 * @returns {object|null} The memory row, or null if not found
 */
export function getAnyMemoryById(id) {
  const memory = stmts.getAnyById.get(id, WORKSPACE_ID);
  if (memory) {
    memory.provenance = getProvenance(id);
  }
  return memory || null;
}

/**
 * Get a memory by ID WITHOUT boosting. Used internally for search results.
 * @param {number} id - Memory ID
 * @param {string|null} namespace - Namespace filter (null = no filter)
 * @returns {object|null} The memory row, or null if not found
 */
export function getMemoryById(id, namespace = null) {
  const [first, second] = accessPair(namespace);
  const memory = stmts.getByIdNs.get(id, WORKSPACE_ID, first, second);
  if (memory) {
    memory.provenance = getProvenance(id);
  }
  return memory || null;
}

/**
 * Update a memory's content. FTS5 index auto-updates via trigger.
 * Caller must also update the vector embedding separately.
 * @returns {boolean} true if the memory existed and was updated
 */
export function updateMemoryContent(id, content) {
  const redactedContent = redactSecrets(content);
  const result = stmts.updateContent.run(redactedContent, id, WORKSPACE_ID);
  return result.changes > 0;
}

/**
 * Delete a vector embedding by memory ID.
 */
export function deleteVec(id) {
  try { stmts.deleteVec.run(BigInt(id)); } catch (e) { /* may not exist */ }
}

/**
 * Delete a memory, its vector embedding, and all associated graph edges.
 * FTS5 index auto-updates via trigger.
 * @returns {boolean} true if the memory existed and was deleted
 */
export function deleteMemory(id, namespace = null) {
  if (!getMemoryById(id, namespace)) return false;
  stmts.deleteEdgesByMemory.run(WORKSPACE_ID, id, id);
  deleteVec(id);  // Remove vector first (no cascades on virtual tables)
  try {
    stmts.deleteProvenanceByMemoryId.run(id);
    stmts.deleteContradictionsByMemoryId.run(id, id);
  } catch (e) {
    console.error(`[scopekeep] Clean up provenance/contradictions error: ${e.message}`);
  }
  const result = stmts.deleteMemory.run(id, WORKSPACE_ID);
  return result.changes > 0;
}

/**
 * Get the N most recently created memories.
 * @param {number} limit - Max results
 * @param {string|null} namespace - Namespace filter (null = shared)
 */
export function getRecentMemories(limit = 10, namespace = null) {
  if (typeof limit !== 'number' || isNaN(limit) || limit <= 0) {
    throw new Error('Limit must be a positive integer.');
  }
  const parsedLimit = Math.floor(limit);
  const [first, second] = accessPair(namespace);
  const rows = stmts.getRecentNs.all(WORKSPACE_ID, first, second, parsedLimit);
  rows.forEach(r => {
    r.provenance = getProvenance(r.id);
  });
  return rows;
}

/**
 * Return the memories that were valid and already asserted at a point in time.
 * Timestamps use Unix milliseconds; provenance is included for review/audit UI.
 *
 * @param {number} asOf - Unix timestamp in milliseconds
 * @param {number} limit - Max results
 * @param {string|null} namespace - Namespace filter
 */
export function getMemoriesAsOf(asOf, limit = 50, namespace = null) {
  if (!Number.isFinite(asOf) || asOf < 0) {
    throw new Error('asOf must be a valid Unix timestamp in milliseconds.');
  }
  if (!Number.isFinite(limit) || limit <= 0) {
    throw new Error('Limit must be a positive integer.');
  }
  const timestamp = Math.trunc(asOf);
  const parsedLimit = Math.min(500, Math.floor(limit));
  const [first, second] = accessPair(namespace);
  const rows = stmts.getAsOfNs.all(
    WORKSPACE_ID,
    first,
    second,
    timestamp,
    timestamp,
    timestamp,
    parsedLimit
  );
  rows.forEach(row => {
    row.provenance = getProvenance(row.id);
  });
  return rows;
}

/**
 * Get the N most important memories (by importance_score).
 * @param {number} limit - Max results
 * @param {string|null} namespace - Namespace filter (null = shared)
 */
export function getImportantMemories(limit = 10, namespace = null) {
  if (typeof limit !== 'number' || isNaN(limit) || limit <= 0) {
    throw new Error('Limit must be a positive integer.');
  }
  const parsedLimit = Math.floor(limit);
  const [first, second] = accessPair(namespace);
  const rows = stmts.getImportantNs.all(WORKSPACE_ID, first, second, parsedLimit);
  rows.forEach(r => {
    r.provenance = getProvenance(r.id);
  });
  return rows;
}

// ============================================================
// MEMORY LIFECYCLE
// ============================================================

/**
 * Boost a memory's importance when it's accessed.
 * Increments access_count, adds 0.1 to importance (max 2.0),
 * and updates last_accessed timestamp.
 */
export function boostMemory(id) {
  stmts.boost.run(id, WORKSPACE_ID);
}

/**
 * Apply temporal decay to old memories.
 * Reduces importance by 5% for memories not accessed in 7+ days.
 * Called automatically every hour by the server.
 */
export function applyTemporalDecay() {
  const result = stmts.decay.run(WORKSPACE_ID);
  if (result.changes > 0) {
    console.error(`[scopekeep] Decay applied to ${result.changes} memories`);
  }
}

// ============================================================
// FTS5 QUERY PREPARATION
// ============================================================

const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'is', 'was', 'are', 'be', 'been', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'can', 'could', 'shall', 'should', 'may', 'might', 'must',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'my', 'your', 'his', 'her',
  'its', 'our', 'their', 'me', 'him', 'us', 'them', 'what', 'which', 'who',
  'whom', 'when', 'where', 'why', 'how', 'this', 'that', 'these', 'those',
  'am', 'not', 'no', 'nor', 'if', 'because', 'so', 'as', 'until', 'while',
  'about', 'between', 'into', 'through', 'during', 'before', 'after',
  'above', 'below', 'up', 'down', 'out', 'off', 'over', 'under', 'again',
  'further', 'then', 'once', 'here', 'there', 'all', 'any', 'both', 'each',
  'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same',
  'too', 'very', 'just', 'also', 'than', 'been', 'being', 'having', 'doing',
  'get', 'got', 'let', 'make', 'them', 'well', 'went', 'were', 'yes',
]);

/**
 * Prepare a natural-language query for FTS5 matching.
 * - Lowercases and tokenizes
 * - Removes English stopwords (common noise words)
 * - Joins remaining terms with OR for lenient matching
 * - The porter stemmer (set in tokenizer) handles morphological variants
 *
 * BM25 ranking ensures documents matching more terms rank highest.
 */
export function prepareFtsQuery(query) {
  const cleaned = query.toLowerCase().replace(/\s+/g, ' ').trim();
  const terms = cleaned.split(/[^a-z0-9']+/).filter(t => t.length > 0).map(t => t.replace(/'/g, ''));
  const filtered = terms.filter(t => t.length > 1 && !STOPWORDS.has(t));

  if (filtered.length === 0) {
    // Fallback: if all terms were stopwords, use the original query
    return cleaned;
  }
  if (filtered.length === 1) {
    return filtered[0];
  }

  // OR matching: any term can match, BM25 ranks by coverage
  return filtered.join(' OR ');
}

// ============================================================
// SEARCH HELPERS (used by search.js)
// ============================================================

/**
 * Keyword search using FTS5 with BM25 ranking.
 * Uses query expansion (stopword removal, OR matching) and
 * the porter stemmer for morphological variant matching.
 * @returns {Array<{id: number, rank: number}>}
 */
export function searchKeyword(query, limit = 10, namespace = null) {
  const ftsQuery = prepareFtsQuery(query);
  const [first, second] = accessPair(namespace);
  try {
    return stmts.searchFts.all(ftsQuery, WORKSPACE_ID, first, second, limit);
  } catch (e) {
    // FTS5 can throw on special characters in query; fallback to raw
    try {
      return stmts.searchFts.all(query, WORKSPACE_ID, first, second, limit);
    } catch (e2) {
      return [];
    }
  }
}

/**
 * Vector similarity search using sqlite-vec KNN.
 * @param {Float32Array} embedding - Query vector (384-dim)
 * @returns {Array<{rowid: number, distance: number}>}
 */
export function searchVector(embedding, limit = 10, namespace = null) {
  if (typeof limit !== 'number' || isNaN(limit) || limit <= 0) {
    throw new Error('Limit must be a positive integer.');
  }
  const parsedLimit = Math.floor(limit);
  const [first, second] = accessPair(namespace);
  const globalVectorCount = Number(db.prepare('SELECT COUNT(*) AS count FROM memories_vec').get().count);
  const candidateLimit = Math.max(parsedLimit, globalVectorCount);
  return stmts.searchVec.all(
    Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength),
    candidateLimit,
    WORKSPACE_ID,
    first,
    second,
    parsedLimit
  );
}

// ============================================================
// ENTITY FUNCTIONS (Knowledge Graph)
// ============================================================

/**
 * Create a named entity (person, tech, project, concept, file).
 * Silently skips if entity with that name already exists.
 * @returns {number|null} The entity ID, or null if already existed
 */
export function insertEntity(name, type) {
  const result = stmts.insertEntity.run(name, type, WORKSPACE_ID);
  if (result.changes === 0) {
    // Already exists — return existing ID
    const existing = stmts.getEntityByName.get(name, WORKSPACE_ID);
    return existing ? existing.id : null;
  }
  return Number(result.lastInsertRowid);
}

/**
 * Get an entity by its name.
 */
export function getEntityByName(name) {
  return stmts.getEntityByName.get(name, WORKSPACE_ID) || null;
}

/**
 * Get an entity by its ID.
 */
export function getEntityById(id) {
  return stmts.getEntityById.get(id, WORKSPACE_ID) || null;
}

/**
 * Get all entities, most recent first.
 */
export function getAllEntities(limit = 50) {
  return stmts.getAllEntities.all(WORKSPACE_ID, limit);
}

/**
 * Delete an entity and its edges.
 */
export function deleteEntity(id) {
  if (!getEntityById(id)) return false;
  stmts.deleteEdgesByEntity.run(WORKSPACE_ID, id, id);
  const result = stmts.deleteEntity.run(id, WORKSPACE_ID);
  return result.changes > 0;
}

/**
 * Create an edge connecting two nodes (entity↔entity or entity↔memory).
 */
export function insertEdge(sourceId, targetId, relation, sourceType, targetType) {
  if (sourceType === 'memory' && !getAnyMemoryById(sourceId)) throw new Error('Source memory is outside the active workspace.');
  if (targetType === 'memory' && !getAnyMemoryById(targetId)) throw new Error('Target memory is outside the active workspace.');
  if (sourceType === 'entity' && !getEntityById(sourceId)) throw new Error('Source entity is outside the active workspace.');
  if (targetType === 'entity' && !getEntityById(targetId)) throw new Error('Target entity is outside the active workspace.');
  stmts.insertEdge.run(sourceId, targetId, relation, sourceType, targetType, WORKSPACE_ID);
}

/**
 * Get all memories linked to an entity.
 */
export function getMemoriesByEntity(entityId, namespace = null) {
  if (!getEntityById(entityId)) return [];
  const edges = stmts.getMemoriesByEntityEdges.all(WORKSPACE_ID, entityId, entityId);
  const memoryIds = edges.map(e => e.source_type === 'memory' ? e.source_id : e.target_id);
  return memoryIds.map(id => getMemoryById(id, namespace)).filter(Boolean);
}

/**
 * Check if a memory with exact content already exists.
 * Used for deduplication.
 * @param {string} content - Exact content to match
 * @param {string|null} namespace - Namespace filter (null = global dedup)
 * @returns {boolean}
 */
export function memoryExists(content, namespace = null) {
  const [first, second] = accessPair(namespace);
  return stmts.findMemoryByContentNs.get(content, WORKSPACE_ID, first, second) !== undefined;
}

/**
 * Check if a memory exists by hash prefix pattern (LIKE query).
 * Used for git commit deduplication where we match `[hashPrefix]%`.
 * @param {string} pattern - SQL LIKE pattern to match (e.g. '[abc1234]%')
 * @returns {boolean}
 */
export function memoryExistsByHashPrefix(pattern) {
  return stmts.findMemoryByHashPrefix.get(pattern, WORKSPACE_ID) !== undefined;
}

/**
 * Get count of active (non-archived) memories.
 * @param {string|null} namespace - Namespace filter (null = all)
 * @returns {number}
 */
export function getActiveMemoryCount(namespace = null) {
  const [first, second] = accessPair(namespace);
  return stmts.getActiveMemoryCountNs.get(WORKSPACE_ID, first, second).count;
}

/**
 * Get namespace breakdown stats.
 * @returns {Array<{namespace: string, count: number}>}
 */
export function getNamespaceStats() {
  return stmts.getNamespaceStats.all(WORKSPACE_ID);
}

/**
 * Get exact content size metrics across all active memories.
 * Returns real character counts — divide by 4 for a precise token estimate
 * (standard GPT/Claude tokenizer approximation: ~4 chars per token).
 * @returns {{ memory_count, total_chars, avg_chars, max_chars, min_chars }}
 */
export function getContentStats() {
  const row = stmts.getContentStats.get(WORKSPACE_ID);
  const totalChars = Number(row.total_chars);
  const avgChars   = Number(row.avg_chars);
  return {
    memory_count:     Number(row.memory_count),
    total_chars:      totalChars,
    avg_chars:        Math.round(avgChars),
    max_chars:        Number(row.max_chars),
    min_chars:        Number(row.min_chars),
    // Exact token estimate (chars / 4 — standard tokenizer approximation)
    raw_tokens_exact: Math.ceil(totalChars / 4),
  };
}

/**
 * Get per-namespace content size stats with exact character counts.
 * @returns {Array<{namespace, count, total_chars, raw_tokens_exact}>}
 */
export function getNamespaceContentStats() {
  return stmts.getNamespaceContentStats.all(WORKSPACE_ID).map(row => ({
    namespace:        row.namespace,
    count:            Number(row.count),
    total_chars:      Number(row.total_chars),
    raw_tokens_exact: Math.ceil(Number(row.total_chars) / 4),
  }));
}


// ============================================================
// DEDUPLICATION BY EXACT CONTENT
// ============================================================

/**
 * Find memory by exact content.
 * @param {string} content
 * @param {string|null} namespace - Namespace filter (null = global)
 * @returns {object|null} The memory row, or null if not found
 */
export function getMemoryByContent(content, namespace = null) {
  const [first, second] = accessPair(namespace);
  const row = stmts.findMemoryByContentNs.get(content, WORKSPACE_ID, first, second);
  return row ? getMemoryById(row.id, namespace) : null;
}

// ============================================================
// TEMPORAL CONTRADICTIONS & AGENT STATS & ATTESTATIONS CRUD
// ============================================================

/**
 * Archive a memory and log the contradiction.
 */
export function logContradiction(oldMemoryId, newMemoryId, reason = '') {
  const oldMemory = getAnyMemoryById(oldMemoryId);
  const newMemory = getAnyMemoryById(newMemoryId);
  if (!oldMemory || !newMemory) {
    throw new Error('Contradiction links must remain inside the active workspace.');
  }
  // Use the new version's validity start as the exact hand-off boundary. If
  // both rows were created within one millisecond, advance the new version by
  // one millisecond so the old version still has a non-empty validity window.
  const boundary = Math.max(Number(newMemory.valid_from), Number(oldMemory.valid_from) + 1);
  if (boundary !== Number(newMemory.valid_from)) {
    stmts.updateTemporalStart.run(boundary, boundary, newMemoryId, WORKSPACE_ID);
  }
  stmts.archiveMemoryAt.run(boundary, oldMemoryId, WORKSPACE_ID);
  stmts.insertContradiction.run(oldMemoryId, newMemoryId, reason);

  // Set parent_id to link memories for bidirectional history tracing (always newer pointing to older)
  try {
    const parentId = Math.min(oldMemoryId, newMemoryId);
    const childId = Math.max(oldMemoryId, newMemoryId);
    stmts.updateMemoryParentId.run(parentId, childId, WORKSPACE_ID);
  } catch (e) {
    console.error(`[scopekeep] Failed to set parent_id on contradiction: ${e.message}`);
  }

  // Retrieve provenance of both versions for game-theoretic reputation calculation
  const oldProvenance = getProvenance(oldMemoryId);
  const newProvenance = getProvenance(newMemoryId);

  if (oldProvenance && oldProvenance.source_type === 'agent' && oldProvenance.source_id) {
    const isSelfCorrection = (newProvenance && newProvenance.source_id &&
                              newProvenance.source_id.toLowerCase() === oldProvenance.source_id.toLowerCase()) ||
                             reason.includes('update_memory');
    if (!isSelfCorrection) {
      // Different agent/manual source contradicts the old memory
      incrementAgentStat(oldProvenance.source_id, 'contradicted');

      // Boost reputation of the confirmer/contradictor if it's an agent
      if (newProvenance && newProvenance.source_type === 'agent' && newProvenance.source_id !== oldProvenance.source_id) {
        incrementAgentStat(newProvenance.source_id, 'confirmed');
      }
    }
  }
}

/**
 * Get provenance for a memory.
 */
export function getProvenance(memoryId) {
  const prov = stmts.getProvenance.get(memoryId) || null;
  if (prov && prov.source_type === 'agent' && prov.source_id) {
    prov.source_id = prov.source_id.toLowerCase();
  }
  return prov;
}

/**
 * Update agent reputation counters.
 */
export function incrementAgentStat(agentId, action) {
  const normalizedAgentId = agentId.toLowerCase();
  if (normalizedAgentId === 'antigravity-worker' || normalizedAgentId === 'user-dialogue') {
    return; // Ignore internal/system identities from reputation penalties
  }
  stmts.upsertAgent.run(normalizedAgentId, WORKSPACE_ID);
  if (action === 'created') {
    stmts.incrementCreated.run(normalizedAgentId, WORKSPACE_ID);
  } else if (action === 'confirmed') {
    stmts.incrementConfirmed.run(normalizedAgentId, WORKSPACE_ID);
  } else if (action === 'contradicted') {
    stmts.incrementContradicted.run(normalizedAgentId, WORKSPACE_ID);
  }
  stmts.recalculateReputation.run(normalizedAgentId, WORKSPACE_ID);
}

/**
 * Get all agent stats.
 */
export function getAllAgentStats() {
  return stmts.getAllAgentStats.all(WORKSPACE_ID);
}

/**
 * Upsert agent signature / record attestation in database.
 */
export function insertAttestation(att) {
  stmts.insertAttestation.run(
    att.attestation_id,
    att.query,
    att.timestamp,
    JSON.stringify(att.memories_retrieved),
    att.agent_id || null,
    att.session_id || null,
    att.signature,
    att.previous_hash || null,
    att.hash,
    WORKSPACE_ID
  );
}

/**
 * Atomically append an attestation after acquiring SQLite's write lock.
 * The callback receives the current workspace chain head and returns a signed record.
 */
export function appendAttestation(createRecord) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = stmts.getLastAttestation.get(WORKSPACE_ID) || null;
    const record = createRecord(previous);
    insertAttestation(record);
    db.exec('COMMIT');
    return record;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

/**
 * Retrieve a specific attestation by ID.
 */
export function getAttestationById(attestationId) {
  return stmts.getAttestation.get(attestationId, WORKSPACE_ID) || null;
}

/**
 * Retrieve the last attestation logged for chaining.
 */
export function getLastAttestation() {
  return stmts.getLastAttestation.get(WORKSPACE_ID) || null;
}

/**
 * Retrieve attestations within a timestamp range.
 */
export function getAttestationsByDateRange(startDate, endDate) {
  return stmts.getAttestationsByDate.all(startDate, endDate, WORKSPACE_ID);
}

/**
 * Traverses contradictions to get historical versions of a memory.
 */
export function getMemoryHistoryChain(memoryId) {
  const versions = new Set();
  const queue = [memoryId];

  while (queue.length > 0) {
    const currentId = queue.shift();
    if (versions.has(currentId)) continue;
    versions.add(currentId);

    // 1. Find parent (ancestor) from memories table
    const row = stmts.getMemoryParentId.get(currentId, WORKSPACE_ID);
    if (row && row.parent_id !== null) {
      if (!versions.has(row.parent_id)) queue.push(row.parent_id);
    }

    // 2. Find children (descendants) from memories table
    const children = stmts.getMemoryChildren.all(currentId, WORKSPACE_ID);
    for (const child of children) {
      if (!versions.has(child.id)) queue.push(child.id);
    }

    // 3. Fallback: Find ancestors (replaced by current) from contradictions table
    const ancestors = stmts.getContradictionAncestors.all(currentId);
    ancestors.forEach(a => {
      if (!versions.has(a.old_memory_id)) queue.push(a.old_memory_id);
    });

    // 4. Fallback: Find descendants (replaces current) from contradictions table
    const descendants = stmts.getContradictionDescendants.all(currentId);
    descendants.forEach(d => {
      if (!versions.has(d.new_memory_id)) queue.push(d.new_memory_id);
    });
  }

  const ids = Array.from(versions);
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT * FROM memories
    WHERE workspace_id = ? AND id IN (${placeholders})
    ORDER BY created_at ASC
  `).all(WORKSPACE_ID, ...ids);

  for (const row of rows) {
    const prov = getProvenance(row.id);
    if (prov) {
      row.source_type = prov.source_type;
      row.source_id = prov.source_id;
      row.confidence = prov.confidence;
    } else {
      row.source_type = 'manual';
      row.source_id = null;
      row.confidence = 1.0;
    }
    if (row.source_type === 'agent' && row.source_id) {
      row.source_id = row.source_id.toLowerCase();
    }
  }

  return rows;
}

/**
 * Search all memories FTS (including archived memories).
 */
export function searchAllMemoriesFts(queryText, limit = 10) {
  try {
    const [first, second] = accessPair(null);
    return stmts.searchFts.all(queryText, WORKSPACE_ID, first, second, limit);
  } catch (e) {
    return [];
  }
}

/**
 * Retrieve the last read position of a watched file.
 */
export function getWatchPosition(filePath) {
  const row = stmts.getWatchPosition.get(filePath, WORKSPACE_ID);
  return row ? row.last_position : 0;
}

/**
 * Upsert the last read position of a watched file.
 */
export function upsertWatchPosition(filePath, position) {
  stmts.upsertWatchPosition.run(filePath, position, WORKSPACE_ID);
}

// ============================================================
// WORKSPACE PRIVACY CONTROLS
// ============================================================

function encodeSqliteValue(value) {
  if (Buffer.isBuffer(value)) {
    return { encoding: 'base64', data: value.toString('base64') };
  }
  if (value instanceof Uint8Array) {
    return { encoding: 'base64', data: Buffer.from(value).toString('base64') };
  }
  return value;
}

function encodeRows(rows) {
  return rows.map(row => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, encodeSqliteValue(value)])
  ));
}

/**
 * Export every record owned by a workspace, including archived memories,
 * derived vector data, provenance, graph data, watcher offsets, and evidence.
 */
export function exportWorkspaceData(workspaceId = WORKSPACE_ID) {
  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new Error('A valid workspace ID is required for privacy export.');
  }

  const records = {
    memories: db.prepare(`
      SELECT * FROM memories
      WHERE workspace_id = ?
      ORDER BY id ASC
    `).all(workspaceId),
    provenance: db.prepare(`
      SELECT p.*
      FROM provenance p
      JOIN memories m ON m.id = p.memory_id
      WHERE m.workspace_id = ?
      ORDER BY p.id ASC
    `).all(workspaceId),
    contradictions: db.prepare(`
      SELECT DISTINCT c.*
      FROM contradictions c
      LEFT JOIN memories old_m ON old_m.id = c.old_memory_id
      LEFT JOIN memories new_m ON new_m.id = c.new_memory_id
      WHERE old_m.workspace_id = ? OR new_m.workspace_id = ?
      ORDER BY c.id ASC
    `).all(workspaceId, workspaceId),
    vectors: encodeRows(db.prepare(`
      SELECT v.rowid AS memory_id, v.embedding
      FROM memories_vec v
      JOIN memories m ON m.id = v.rowid
      WHERE m.workspace_id = ?
      ORDER BY v.rowid ASC
    `).all(workspaceId)),
    entities: db.prepare('SELECT * FROM entities WHERE workspace_id = ? ORDER BY id ASC').all(workspaceId),
    edges: db.prepare('SELECT * FROM edges WHERE workspace_id = ? ORDER BY id ASC').all(workspaceId),
    agent_stats: db.prepare('SELECT * FROM agent_stats WHERE workspace_id = ? ORDER BY agent_id ASC').all(workspaceId),
    attestations: db.prepare('SELECT * FROM attestations WHERE workspace_id = ? ORDER BY id ASC').all(workspaceId),
    watched_files: db.prepare('SELECT * FROM watched_files WHERE workspace_id = ? ORDER BY file_path ASC').all(workspaceId)
  };

  return {
    format: 'scopekeep-workspace-export',
    format_version: 1,
    exported_at: new Date().toISOString(),
    workspace_id: workspaceId,
    workspace_root: workspaceId === WORKSPACE_ID ? WORKSPACE_ROOT : null,
    schema: Object.fromEntries(
      db.prepare('SELECT key, value FROM schema_meta ORDER BY key ASC')
        .all()
        .map(row => [row.key, row.value])
    ),
    records,
    counts: Object.fromEntries(
      Object.entries(records).map(([name, rows]) => [name, rows.length])
    )
  };
}

function countWorkspaceRecords(workspaceId) {
  const directTables = ['memories', 'entities', 'edges', 'agent_stats', 'attestations', 'watched_files'];
  const counts = Object.fromEntries(directTables.map(table => [
    table,
    Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE workspace_id = ?`).get(workspaceId).count)
  ]));

  counts.provenance = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM provenance p
    JOIN memories m ON m.id = p.memory_id
    WHERE m.workspace_id = ?
  `).get(workspaceId).count);
  counts.contradictions = Number(db.prepare(`
    SELECT COUNT(DISTINCT c.id) AS count
    FROM contradictions c
    LEFT JOIN memories old_m ON old_m.id = c.old_memory_id
    LEFT JOIN memories new_m ON new_m.id = c.new_memory_id
    WHERE old_m.workspace_id = ? OR new_m.workspace_id = ?
  `).get(workspaceId, workspaceId).count);
  counts.vectors = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM memories_vec v
    JOIN memories m ON m.id = v.rowid
    WHERE m.workspace_id = ?
  `).get(workspaceId).count);

  return counts;
}

/**
 * Permanently remove every record owned by a workspace and verify the result.
 * This is deliberately not exposed as an agent-callable MCP tool.
 */
export function purgeWorkspaceData({ workspaceId = WORKSPACE_ID, vacuum = true } = {}) {
  if (!workspaceId || typeof workspaceId !== 'string') {
    throw new Error('A valid workspace ID is required for workspace purge.');
  }

  const before = countWorkspaceRecords(workspaceId);
  const memoryIds = db.prepare(
    'SELECT id FROM memories WHERE workspace_id = ? ORDER BY id ASC'
  ).all(workspaceId).map(row => row.id);

  db.exec('BEGIN IMMEDIATE');
  try {
    const deleteVector = db.prepare('DELETE FROM memories_vec WHERE rowid = ?');
    for (const id of memoryIds) deleteVector.run(id);

    db.prepare(`
      DELETE FROM contradictions
      WHERE old_memory_id IN (SELECT id FROM memories WHERE workspace_id = ?)
         OR new_memory_id IN (SELECT id FROM memories WHERE workspace_id = ?)
    `).run(workspaceId, workspaceId);
    db.prepare(`
      DELETE FROM provenance
      WHERE memory_id IN (SELECT id FROM memories WHERE workspace_id = ?)
    `).run(workspaceId);
    db.prepare('DELETE FROM edges WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM entities WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM agent_stats WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM attestations WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM watched_files WHERE workspace_id = ?').run(workspaceId);
    db.prepare('DELETE FROM memories WHERE workspace_id = ?').run(workspaceId);
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw error;
  }

  if (DB_PATH !== ':memory:') {
    db.pragma('wal_checkpoint(TRUNCATE)');
    if (vacuum) db.exec('VACUUM');
  }

  const after = countWorkspaceRecords(workspaceId);
  const verified = Object.values(after).every(count => count === 0);
  if (!verified) {
    throw new Error(`Workspace purge verification failed: ${JSON.stringify(after)}`);
  }

  return {
    workspace_id: workspaceId,
    purged_at: new Date().toISOString(),
    secure_delete: db.pragma('secure_delete', { simple: true }) === 1,
    wal_checkpointed: DB_PATH !== ':memory:',
    vacuumed: DB_PATH !== ':memory:' && vacuum,
    before,
    after,
    verified
  };
}

// ============================================================
// CLEANUP
// ============================================================

/**
 * Archive transient memories (reminders and notes) older than 14 days.
 * Returns the count of archived memories.
 */
export function archiveExpiredMemories() {
  try {
    const info = stmts.archiveExpiredTransientMemories.run(WORKSPACE_ID);
    if (info.changes > 0) {
      console.error(`[scopekeep] Archived ${info.changes} expired transient memories (Note/Reminder older than 14 days).`);
    }
    return info.changes;
  } catch (e) {
    console.error(`[scopekeep] Failed to archive expired memories: ${e.message}`);
    return 0;
  }
}

/**
 * Close the database connection. Call on shutdown.
 */
export function closeDatabase() {
  db.close();
  console.error('[scopekeep] Database closed');
}

// Run auto-expiry cleanup on database startup to prune transient bloat immediately
try {
  archiveExpiredMemories();
} catch (_) {}

export default db;
