# Historical HIPAA Security & Privacy Control Mapping

> **Status:** Engineering mapping draft, not a certification, legal opinion, or substitute for a HIPAA risk analysis or Business Associate Agreement assessment.

This document describes controls that may help healthcare developers assess the use of AI coding agents. ScopeKeep does not guarantee HIPAA compliance and does not determine whether a BAA is required.

---

## 1. Local ScopeKeep Processing Boundary
Under HIPAA, transmitting Protected Health Information (PHI) to third-party APIs requires a Business Associate Agreement (BAA). 

* **ScopeKeep Boundary**: ScopeKeep stores memory, computes embeddings, and performs semantic matches locally. It does not initiate cloud synchronization.
* **Surrounding Data Flows**: An MCP client may send retrieved context to its configured AI provider. Whether a BAA is required depends on the actual parties, deployment, data, and services and must be assessed by the healthcare organization.

---

## 2. Access Control and Technical Safeguards (§ 164.312)

### A. Access Control (§ 164.312(a))
* **Local OS Authentication**: ScopeKeep inherits the underlying operating system's access controls. Workspace databases under `~/.scopekeep/` rely on user-level permissions and should be protected with full-disk encryption.
* **Namespace Isolation**: Multiprocess or swarm-based setups can partition data using namespace parameters, ensuring distinct sub-agents only query data specifically approved for their context scope.

### B. Audit Controls (§ 164.312(b))
* **Cryptographic Ledger**: ScopeKeep automatically records a tamper-evident audit trail of all memories retrieved during AI developer sessions.
* **Tamper-Evident Chain**: Retrieval evidence can be signed and linked to the previous record's hash. This can detect some record changes; it does not prove that no unauthorized context access or database modification occurred.

### C. Transmission Security (§ 164.312(e))
* **Local-First Default**: Core storage and retrieval are local. Operators must separately review any explicitly enabled cloud extraction, integrations, backups, telemetry, and surrounding AI clients.
* **Local Loopback Encryption**: If the HTTP gateway is enabled, it binds strictly to `127.0.0.1` by default to prevent external listening. For multi-node swarms, TLS/HTTPS configuration is required.
