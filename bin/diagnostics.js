#!/usr/bin/env node

import { accessSync, constants, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import db, {
  ACTIVE_DATABASE_PATH,
  DATABASE_ENCRYPTION_STATUS,
  WORKSPACE_ID,
  WORKSPACE_ROOT,
  closeDatabase
} from '../src/database.js';

function nodeVersionSupported() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 20 || (major === 20 && minor >= 19);
}

function inspectVSCodeConfig() {
  const configPath = join(WORKSPACE_ROOT, '.vscode', 'mcp.json');
  if (!existsSync(configPath)) {
    return { configured: false, path: configPath, reason: 'not found' };
  }

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const server = config?.servers?.scopekeep;
    if (!server) return { configured: false, path: configPath, reason: 'scopekeep server missing' };
    const portableRoot = server.env?.SCOPEKEEP_WORKSPACE_ROOT === '${workspaceFolder}';
    return {
      configured: true,
      path: configPath,
      transport: server.type || 'stdio',
      command: server.command,
      portable_root: portableRoot
    };
  } catch (error) {
    return { configured: false, path: configPath, reason: `invalid JSON: ${error.message}` };
  }
}

export function collectStatus() {
  const memoryCounts = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN valid_until IS NULL THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN valid_until IS NOT NULL THEN 1 ELSE 0 END) AS archived
    FROM memories
    WHERE workspace_id = ?
  `).get(WORKSPACE_ID);

  return {
    version: JSON.parse(
      readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf8')
    ).version,
    workspace_root: WORKSPACE_ROOT,
    workspace_id: WORKSPACE_ID,
    database: ACTIVE_DATABASE_PATH,
    database_encryption: DATABASE_ENCRYPTION_STATUS,
    memories: {
      total: Number(memoryCounts.total || 0),
      active: Number(memoryCounts.active || 0),
      archived: Number(memoryCounts.archived || 0)
    },
    capture: process.env.PERSYST_CAPTURE_ENABLED === '1' ? 'enabled' : 'off',
    http_gateway: process.env.PERSYST_HTTP_ENABLED === '1' ? 'enabled' : 'off',
    vscode: inspectVSCodeConfig()
  };
}

export function runStatus() {
  try {
    const status = collectStatus();
    console.log('');
    console.log(`ScopeKeep ${status.version}`);
    console.log(`Workspace:    ${status.workspace_root}`);
    console.log(`Workspace ID: ${status.workspace_id}`);
    console.log(`Database:     ${status.database}`);
    console.log(`Encryption:   ${status.database_encryption.enabled ? `enabled (${status.database_encryption.key_source})` : 'disabled'}`);
    console.log(`Memories:     ${status.memories.active} active, ${status.memories.archived} archived`);
    console.log(`Capture:      ${status.capture}`);
    console.log(`HTTP gateway: ${status.http_gateway}`);
    console.log(`VS Code MCP:  ${status.vscode.configured ? 'configured' : `not configured (${status.vscode.reason})`}`);
    console.log('');
    return status;
  } finally {
    closeDatabase();
  }
}

export function runDoctor() {
  let failures = 0;
  let warnings = 0;
  const report = [];

  const check = (label, passed, detail, severity = 'error') => {
    const state = passed ? 'PASS' : severity === 'warning' ? 'WARN' : 'FAIL';
    report.push({ label, state, detail });
    if (!passed && severity === 'warning') warnings += 1;
    if (!passed && severity !== 'warning') failures += 1;
  };

  try {
    check('Node.js', nodeVersionSupported(), `v${process.versions.node}; requires >=20.19`);

    let writable = true;
    try { accessSync(WORKSPACE_ROOT, constants.R_OK | constants.W_OK); } catch (_) { writable = false; }
    check('Workspace access', writable, WORKSPACE_ROOT);

    const integrity = db.pragma('quick_check', { simple: true });
    check('SQLite integrity', integrity === 'ok', String(integrity));
    check(
      'Database encryption',
      DATABASE_ENCRYPTION_STATUS.enabled,
      DATABASE_ENCRYPTION_STATUS.enabled
        ? `enabled (${DATABASE_ENCRYPTION_STATUS.key_source})`
        : 'disabled by configuration',
      'warning'
    );

    const vscode = inspectVSCodeConfig();
    check(
      'VS Code MCP',
      vscode.configured,
      vscode.configured ? vscode.path : `${vscode.path}: ${vscode.reason}`,
      'warning'
    );
    if (vscode.configured) {
      check(
        'Portable boundary',
        vscode.portable_root,
        vscode.portable_root ? '${workspaceFolder}' : 'SCOPEKEEP_WORKSPACE_ROOT is not portable',
        'warning'
      );
    }

    check(
      'Transcript capture',
      process.env.PERSYST_CAPTURE_ENABLED !== '1',
      process.env.PERSYST_CAPTURE_ENABLED === '1' ? 'explicitly enabled' : 'off by default',
      'warning'
    );

    console.log('');
    console.log('ScopeKeep doctor');
    for (const item of report) {
      console.log(`${item.state.padEnd(4)}  ${item.label.padEnd(20)} ${item.detail}`);
    }
    console.log('');
    console.log(failures === 0
      ? `Ready${warnings ? ` with ${warnings} warning(s)` : ''}.`
      : `${failures} blocking check(s) failed.`);
    console.log('');

    if (failures > 0) process.exitCode = 1;
    return { failures, warnings, report };
  } finally {
    closeDatabase();
  }
}
