# Historical EU AI Act & GDPR Control Mapping

> **Status:** Historical engineering draft. This is not a formal compliance specification, certification, or legal opinion. Validate all controls against the current ScopeKeep code, the concrete intended purpose, and the customer's deployment. See [README.md](README.md) and [SCOPEKEEP-PRIVACY-MANIFEST.md](SCOPEKEEP-PRIVACY-MANIFEST.md).

This document maps selected product controls to themes in the **European Union AI Act (Regulation 2024/1689)** and the **General Data Protection Regulation (GDPR - Regulation 2016/679)**.

---

## 🇪🇺 EU AI Act Compliance (Regulation 2024/1689)

### 1. Transparency & Explainability (Article 13(1))
* **Provenance Tracking**: Every memory stored in ScopeKeep includes cryptographic metadata: `source_type` (`agent`, `user-dialogue`, `git-commit`), `source_id` (agent identifier or commit hash), and `confidence` score.
* **Context Inspection**: When context is injected via `/system-prompt` or MCP tool queries, the origin provenance is explicitly exposed to the requesting LLM agent so outputs can be traced back to factual source code or user rules.

### 2. Cryptographic Auditability (Article 13(3))
* **Signed Attestations**: Every hybrid search query generates an Ed25519-signed search attestation containing the query string, result set hashes, timestamp, and agent ID.
* **Verification**: Audit logs can be exported using `export_audit_log` and verified offline using `verify_attestation` or the `persyst-export` binary.

### 3. Human Oversight & Anti-Bias (Article 13(4))
* **Reputation Ledger**: ScopeKeep tracks individual agent reputation scores (`agent_stats`). If an agent generates conflicting or low-quality memories, its reputation score decays.
* **Trust-Weighted Retrieval**: Retrieval algorithms automatically penalize memories from low-reputation agents and filter out unverified contradictions.

---

## 🔒 GDPR Compliance (Regulation 2016/679)

### 1. Right to be Forgotten / Erasure (Article 17)
* **Complete Data Removal**: Calling `delete_memory(id)` or `delete_entity(id)` permanently removes:
  - SQLite main table memory row (`memories`)
  - Full-Text Search FTS5 index entry (`memories_fts`)
  - KNN Vector Embedding row (`vec_memories`)
  - Knowledge graph edges (`edges`)
  - Provenance & contradiction records (`provenance`, `contradictions`)

### 2. Right to Data Portability (Article 20)
* **Local Data Portability**: Users retain 100% ownership of their data stored in a local SQLite file (`~/.persyst/persyst.db`).
* **CLI Export & Import**:
  - Export: `npx persyst-export` exports all active memories, entities, edges, and attestations into structured JSON/JSONL format.
  - Import: `npx persyst-import` restores exported databases into any local environment.

### 3. Privacy by Design & Data Minimization (Article 25)
* **Local-First Architecture**: 100% of embeddings and vector searches execute locally on device via `@huggingface/transformers` ONNX WebAssembly. Zero data is transmitted to external clouds or third-party telemetry servers.
* **Automated Secret Redaction**: ScopeKeep redacts API keys, passwords, database URLs, JWT tokens, and private keys on write prior to storing them in SQLite or generating vector embeddings.
* **Auto-Expiry**: Transient memories (reminders, temporary notes) are automatically archived after 14 days to prevent storage bloat and unnecessary data retention.

---

## 📜 Summary of Compliance Features

| Requirement | Supported Feature | Command / API Tool |
|---|---|---|
| Transparency | Provenance Metadata & Attestations | `export_audit_log`, `verify_attestation` |
| Data Erasure | Permanent Vector + Database Deletion | `delete_memory`, `delete_entity` |
| Data Portability | JSON / JSONL Data Export | `npx persyst-export` |
| Data Minimization | Secret Redaction & 14-Day Expiry | Automated (`redactSecrets`, `archiveExpiredMemories`) |
| EU Data Sovereignty | Local-First On-Device Execution | Local SQLite & ONNX embedding engine |
