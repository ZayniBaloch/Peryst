# ScopeKeep Privacy & Compliance Manifest

> **ScopeKeep — Governed, project-scoped context for AI coding teams.**

---

## 1. Intended Purpose Statement

ScopeKeep is designed to provide project-scoped memory and context retrieval for AI coding assistants (such as Claude Code, Cursor, and MCP-compatible developer tools). Its sole purpose is to retrieve relevant code guidelines, architectural patterns, decisions, and documentation locally within the boundaries of an explicitly authorized software repository.

---

## 2. Explicit Prohibitions (Non-Negotiable)

ScopeKeep must **never** be configured, deployed, or modified to perform:

1. **Employee Productivity Scoring**: Measuring developer output, lines of code written, commit velocity, or working hours.
2. **Developer Performance Rankings**: Comparing developers, generating leaderboards, or evaluating individual skill levels.
3. **Automated Employment Decisions**: Influencing hiring, compensation, promotion, performance review, or disciplinary actions.
4. **Behavioral or Emotion Inference**: Analyzing tone, sentiment, emotion, or psychological attributes of team members.
5. **Covert Employee Monitoring**: Background scraping of private chats, non-workspace directories, personal files, or un-consented activities.

---

## 3. GDPR Data Protection Controls

### Data Minimisation & Opt-In Capture
- **Opt-In Requirement**: Automatic transcript watching and IDE history tracking are **disabled by default**. Capture requires explicit administrator and user opt-in (`capture_enabled: true` in workspace configuration).
- **Secret & PII Scrubbing**: The MCP write path applies the built-in Secret Scanner (`src/secret-scanner.js`) before persistence, and all database inserts apply credential-pattern redaction. These heuristic controls cover common API keys, JWTs, AWS credentials, private keys, and email addresses, but they are not a guarantee that every secret or personal identifier will be detected.

### Local Processing Boundary
- ScopeKeep does not initiate cloud synchronization for stored memories and computes its embeddings locally.
- An MCP client may send retrieved context to its configured AI model provider. Customers must assess that separate client/provider data flow.
- Workspace SQLite databases are encrypted at rest by default. The automatic local key file is restricted to the current user where the operating system supports it; deployments may instead inject `SCOPEKEEP_DB_KEY` or `SCOPEKEEP_DB_KEY_FILE` from a managed secret store. Full-disk encryption and operating-system access controls remain recommended because a compromised user session can access both the running process and its local key.

### Data Subject Rights (Right to Erasure & Access)
- **Verified Workspace Deletion**: An operator can permanently delete the active workspace with `scopekeep purge-workspace --confirm=<workspace-id>`. The command deletes all workspace-owned records, verifies zero remaining rows, checkpoints the SQLite WAL, and runs `VACUUM`. It is intentionally unavailable as an agent-callable MCP tool.
- **Access & Portability**: `scopekeep privacy-export [output.json]` exports the complete active workspace record set, including archived memories, provenance, derived vector data, graph data, watcher offsets, and signed retrieval evidence. `scopekeep export` and `scopekeep import` remain the memory-only backup and migration format.
- **Current Scope**: The verified deletion control operates per workspace. Per-user and per-entity erasure require reliable subject attribution and are not claimed by the current release.

---

## 4. EU AI Act Classification Statement

ScopeKeep is intended as a developer-support and context-governance tool. In that intended configuration, and without employment scoring, worker management, biometric, safety, or other regulated decision functions, it is designed to remain in the EU AI Act's **limited or no-risk** category. This is a product posture, not a binding legal classification; classification follows the concrete intended purpose and deployment.

Providers and deployers must still address applicable horizontal duties, including AI literacy, data protection, cybersecurity, and any transparency duty triggered by the surrounding AI system. Using ScopeKeep for employment or worker-management decisions can materially change the risk classification and is outside the supported purpose.

*Advertising ScopeKeep as "EU AI Act Compliant" is prohibited because formal compliance depends on customer deployment, contracts, and operational governance. ScopeKeep provides technical privacy and AI-governance controls.*
