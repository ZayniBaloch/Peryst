#!/usr/bin/env node

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { uninstallWorkspace } from '../bin/uninstall.js';

const workspace = mkdtempSync(join(tmpdir(), 'scopekeep-uninstall-'));
mkdirSync(join(workspace, '.vscode'), { recursive: true });
writeFileSync(join(workspace, '.vscode', 'mcp.json'), JSON.stringify({
  servers: {
    existing: { command: 'existing-tool' },
    scopekeep: { command: 'scopekeep' }
  }
}));
writeFileSync(join(workspace, '.scopekeeprules.md'), '# Persyst Memory Integration\nGenerated');

const result = uninstallWorkspace(workspace);
const config = JSON.parse(readFileSync(join(workspace, '.vscode', 'mcp.json'), 'utf8'));

if (config.servers.scopekeep) throw new Error('ScopeKeep MCP server was not removed');
if (!config.servers.existing) throw new Error('Unrelated MCP server was removed');
if (!result.memories_preserved) throw new Error('Uninstall must preserve memory data');

console.log('ScopeKeep uninstall preserves unrelated MCP configuration and memory data.');
