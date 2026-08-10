# Historical SOC 2 Control Mapping

> **Status:** Engineering mapping draft, not a SOC 2 report, certification, auditor opinion, or guarantee. Validate design and operating effectiveness in the customer's environment.

This document maps ScopeKeep's architectural and functional safeguards to SOC 2 Type II Trust Services Criteria (TSC) for **Security, Confidentiality, and Privacy**.

ScopeKeep is a local-first memory layer for AI agents. Its storage and embedding processes run locally, while customers remain responsible for the surrounding MCP client, model provider, identity, endpoint, and operational controls.

---

## CC6.1: Logical Access Controls
> *The entity restricts logical access to security assets, infrastructure, and information assets to authorized users...*

* **Local-First Isolation**: ScopeKeep does not initiate cloud synchronization for its database. All DB instances are loaded in-process or accessed through a local loopback HTTP interface (`127.0.0.1`) by default. Retrieved context may be transmitted by the customer's MCP client.
* **Namespace Boundary Enforcement**: AI agents are isolated by namespaces (`namespace` column in the SQLite schema). A coding agent bound to a specific repository or namespace cannot access, query, or search facts belonging to another agent's namespace, unless explicitly configured to write to the `shared` namespace.

---

## CC6.3: Transmission and Encryption Controls
> *The entity prevents unauthorized access to data during transmission...*

* **Local Computation**: Vector similarity calculations, full-text searches, and heuristic extraction execute inside the developer's workstation or target environment using local SQLite and local embeddings.
* **No ScopeKeep Cloud Sync**: ScopeKeep has no cloud synchronization by default. Customers must separately control AI-provider, backup, integration, and explicitly enabled network data flows.

---

## CC6.5: Secret and Credential Protection
> *The entity protects credentials and transmission secrets from exposure...*

* **Automatic Secret Redaction**: ScopeKeep employs a heuristic scanner on all incoming log files and text writes.
* **Redaction Coverage**: High-entropy strings matching pattern signatures for API keys (e.g., OpenAI, Google, AWS, GitHub PATs), Private Keys, Database connection URLs, and JSON Web Tokens (JWT) are automatically replaced with `[REDACTED_SECRET]` before they are persisted to the database.

---

## CC8.1: Auditing & Cryptographic Chain of Custody
> *The entity implements logs and audit trails to monitor system activity...*

* **Ed25519 Cryptographic Attestation**: For every search, retrieval, or context injection query, ScopeKeep generates an Ed25519 cryptographic signature. This signature seals:
  1. The search query.
  2. The hash of every retrieved memory block.
  3. The identifier of the requesting agent.
  4. The timestamp.
* **Hash-Chaining (Ledger)**: Each attestation record contains the SHA-256 hash of the *previous* attestation record, creating a tamper-evident audit ledger.
* **Tamper Verification**: Operators can validate the signed retrieval-evidence chain programmatically. This detects some evidence-record changes but does not guarantee that no memory injection or manipulation occurred.
