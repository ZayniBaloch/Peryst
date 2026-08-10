import assert from 'assert';
import { getWorkspaceDatabasePath, WORKSPACE_ID } from '../src/database.js';

console.log('🧪 Testing ScopeKeep Workspace Scoping & Isolation...');

// 1. Verify WORKSPACE_ID format
assert.ok(WORKSPACE_ID.startsWith('ws_'), 'WORKSPACE_ID must start with ws_');
assert.ok(WORKSPACE_ID.length >= 20, 'WORKSPACE_ID must have robust hash length');

// 2. Verify workspace db path generation
const wsA = 'ws_repo_alpha_123';
const wsB = 'ws_repo_beta_456';

const pathA = getWorkspaceDatabasePath(wsA);
const pathB = getWorkspaceDatabasePath(wsB);

assert.ok(pathA.includes(wsA), 'Path A must contain workspace A ID');
assert.ok(pathB.includes(wsB), 'Path B must contain workspace B ID');
assert.notStrictEqual(pathA, pathB, 'Paths for repo A and repo B must be physically distinct');

console.log('✅ ScopeKeep Workspace Isolation tests passed!');
