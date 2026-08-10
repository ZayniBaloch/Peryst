import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRequestedEditors, writeVSCodeConfig } from '../bin/init.js';

const workspace = mkdtempSync(join(tmpdir(), 'scopekeep-vscode-'));

assert.deepEqual(parseRequestedEditors(['--mcp', 'vscode,cursor']), ['vscode', 'cursor']);
assert.deepEqual(parseRequestedEditors(['--mcp=vscode,claude-code']), ['vscode', 'claude-code']);

writeVSCodeConfig('fixture-project', workspace);

const config = JSON.parse(readFileSync(join(workspace, '.vscode', 'mcp.json'), 'utf8'));
assert.equal(config.servers.scopekeep.type, 'stdio');
assert.equal(config.servers.scopekeep.command, 'node');
assert.deepEqual(config.servers.scopekeep.args, ['${workspaceFolder}/index.js']);
assert.equal(config.servers.scopekeep.env.PERSYST_PROJECT, 'fixture-project');
assert.equal(config.servers.scopekeep.env.SCOPEKEEP_WORKSPACE_ROOT, '${workspaceFolder}');

console.log('VS Code integration: config merge, portable workspace scope, and both CLI flag forms verified.');
