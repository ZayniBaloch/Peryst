#!/usr/bin/env node

/**
 * ScopeKeep Daemon — `scopekeepd`
 *
 * Single background process controlling database persistence,
 * search indexing, maintenance jobs, and local authenticated IPC.
 */

import { startServer } from '../src/server.js';
import { logInfo } from '../src/text-utils.js';

logInfo('🚀 Starting ScopeKeep Daemon (scopekeepd)...');

startServer().catch(err => {
  console.error('❌ ScopeKeep daemon failed to start:', err.message);
  process.exit(1);
});
