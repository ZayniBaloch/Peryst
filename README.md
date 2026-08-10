# ScopeKeep

ScopeKeep is governed, project-scoped memory for AI coding tools. It runs locally, keeps retrieval inside an explicit workspace boundary, proposes conflicting-memory changes for review, and can produce signed retrieval evidence.

> **Release status:** ScopeKeep 3 is a public alpha. The older `persyst-mcp` package is not equivalent to this hardened release.

## What the current release does

- Separates workspaces by a canonical repository-root hash and enforces that boundary in memory, search, graph, watcher, statistics, and evidence queries.
- Supports MCP over stdio for VS Code, Cursor, Claude Code, and other MCP clients.
- Keeps transcript capture off by default. Explicit capture directories and `PERSYST_CAPTURE_ENABLED=1` are required.
- Redacts common credential patterns before memory persistence.
- Uses local SQLite, FTS5, sqlite-vec, and local embeddings by default.
- Turns consolidation and contradiction handling into review proposals instead of silently mutating stored knowledge.
- Provides a complete workspace privacy export and a confirmation-gated, verified workspace purge.
- Keeps the HTTP gateway off in production unless explicitly enabled and authenticated.

## Requirements

- Node.js 20.19 or newer
- Git

## Quick start

```bash
npx scopekeep@latest init --mcp=vscode
scopekeep doctor
scopekeep status
```

For VS Code, the setup command creates `.vscode/mcp.json` with a local stdio server and a portable `${workspaceFolder}` boundary. VS Code will ask the user to trust the MCP server before it starts.

To work from a source checkout instead:

```bash
npm install
node index.js
```

## VS Code MCP configuration

The generated workspace configuration follows VS Code's native MCP format:

```json
{
  "servers": {
    "scopekeep": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "scopekeep"],
      "env": {
        "SCOPEKEEP_WORKSPACE_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

This makes the direct MCP connection deterministic and project-portable. Passive IDE transcript capture is a separate opt-in feature and is not required for MCP retrieval.

## Local-first boundary

ScopeKeep stores memories and computes embeddings locally and does not initiate cloud synchronization. When an MCP client retrieves a memory, that client may include the returned text in a request to its configured AI provider. Review the client and model provider's data-handling policy separately.

Workspace databases are encrypted at rest by default. ScopeKeep creates a per-workspace key file with user-only permissions, or you can supply `SCOPEKEEP_DB_KEY` / `SCOPEKEEP_DB_KEY_FILE` from your own secret manager. Existing plaintext workspace databases are checkpointed and encrypted automatically on first open. Keep the key separate from database backups and continue using operating-system access controls and full-disk encryption for defense in depth.

Historical incident review is available through the read-only `get_memories_as_of` MCP tool. It accepts an ISO-8601 date or Unix timestamp and reconstructs the memory versions that were valid and already asserted at that instant.

## Privacy controls

Export all records owned by the active workspace:

```bash
node index.js privacy-export workspace-data.json
```

Purge the active workspace:

```bash
node index.js purge-workspace --confirm=<workspace-id>
```

The purge command requires the exact active workspace ID, is unavailable to MCP agents, deletes all workspace-owned records, verifies that no rows remain, checkpoints the SQLite WAL, and runs `VACUUM`.

The memory-only JSONL backup format remains available:

```bash
node index.js export memories.jsonl
node index.js import memories.jsonl --dry-run
node index.js import memories.jsonl
```

Remove ScopeKeep's workspace integration without deleting memories:

```bash
scopekeep uninstall
```

## Optional HTTP gateway

The production HTTP gateway is disabled by default. Enable it only when required:

```bash
PERSYST_HTTP_ENABLED=1 PERSYST_API_KEY=<strong-random-token> node index.js
```

Binding beyond loopback requires an explicit API key. The generic `/tool` compatibility endpoint is separately gated by `PERSYST_ENABLE_GENERIC_TOOL=1`.

## EU product posture

ScopeKeep is intended as a developer-support and context-governance tool. It must not be used for employee scoring, performance ranking, covert monitoring, emotion inference, or automated employment decisions.

The product provides technical controls that can support GDPR and EU AI Act governance, but it does **not** make a blanket compliance claim. Legal classification and obligations depend on the customer's deployment, data flows, contracts, users, and intended purpose. See [SCOPEKEEP-PRIVACY-MANIFEST.md](compliance/SCOPEKEEP-PRIVACY-MANIFEST.md).

## Known alpha limitations

- Passive VS Code/Cursor transcript capture is opt-in and not considered launch-grade on Windows; use direct MCP calls for reliable operation.
- Per-user and per-entity erasure are not claimed because the current schema does not reliably attribute every record to a data subject.
- Signed retrieval evidence is a product audit feature, not a certification or proof of regulatory compliance.
- Team administration, policy approval workflows, retention scheduling, and enterprise identity controls remain roadmap work.

## Test

```bash
npm test
npm run test:smoke
```

`npm test` runs the complete sequential suite across retrieval, isolation, privacy, security, SDK, gateway, and editor integration behavior.

## License

MIT. See [LICENSE](LICENSE).
