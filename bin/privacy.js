#!/usr/bin/env node

/**
 * ScopeKeep privacy controls.
 *
 * Usage:
 *   scopekeep privacy-export [output.json]
 *   scopekeep purge-workspace --confirm=<workspace-id>
 */

import { writeFileSync } from 'fs';
import {
  WORKSPACE_ID,
  closeDatabase,
  exportWorkspaceData,
  purgeWorkspaceData
} from '../src/database.js';

function getConfirmation(args) {
  const inline = args.find(arg => arg.startsWith('--confirm='));
  if (inline) return inline.slice('--confirm='.length);
  const index = args.indexOf('--confirm');
  return index >= 0 ? args[index + 1] : null;
}
export async function runPrivacyCommand(command, args = process.argv.slice(3)) {
  try {
    if (command === 'privacy-export') {
      const output = args.find(arg => !arg.startsWith('--')) ||
        `scopekeep-workspace-export-${Date.now()}.json`;
      const payload = exportWorkspaceData();
      writeFileSync(output, `${JSON.stringify(payload, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
      console.log(`[OK] Exported complete workspace data to: ${output}`);
      console.log(`     Workspace: ${payload.workspace_id}`);
      console.log(`     Memories: ${payload.counts.memories}`);
      return payload;
    }

    if (command === 'purge-workspace') {
      const confirmation = getConfirmation(args);
      if (confirmation !== WORKSPACE_ID) {
        throw new Error(
          `Destructive purge refused. Re-run with --confirm=${WORKSPACE_ID}`
        );
      }
      const result = purgeWorkspaceData();
      console.log(`[OK] Workspace purge verified: ${result.workspace_id}`);
      console.log(`     Deleted memories: ${result.before.memories}`);
      console.log(`     Secure delete: ${result.secure_delete ? 'enabled' : 'unavailable'}`);
      console.log(`     WAL checkpoint: ${result.wal_checkpointed ? 'complete' : 'in-memory database'}`);
      return result;
    }

    throw new Error(`Unknown privacy command: ${command}`);
  } finally {
    closeDatabase();
  }
}
