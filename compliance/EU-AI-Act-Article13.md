# Historical EU AI Act Article 13 Control Mapping

> **Status:** Engineering mapping draft, not a certification or legal opinion. Article 13 applies to high-risk systems; ScopeKeep's intended developer-support use is not itself represented as high-risk. Reassess this mapping for each deployment.

This document maps ScopeKeep controls that may support a customer's transparency work under **Article 13 of the European Union AI Act**. It does not establish that ScopeKeep or a surrounding system satisfies Article 13.

Article 13 mandates that high-risk AI systems must be designed and developed in such a way to ensure that their operation is sufficiently transparent to enable users to interpret the system’s output and use it appropriately.

---

## 1. Traceability of System Outputs (Article 13(1))
High-risk AI assistants must provide users with clear insight into the data and parameters used to make decisions or generate code.

* **Heuristic Provenance Logs**: ScopeKeep records detailed origin data for every memory. Every fact in the database is linked to its `source_type` (e.g., `agent`, `user-dialogue`, `git-commit`), `source_id` (identifying the specific agent or commit hash), and a `confidence` rating.
* **Source Attribution**: When context is injected into an AI system (via `/system-prompt`), the source files, authors, and timestamps of the memories are appended to the context so developers can verify the factual origin of code recommendations.

---

## 2. Cryptographic Audit Trails (Article 13(3))
ScopeKeep's attestation mechanism can contribute retrieval evidence to a broader logging and traceability program:

* **Retrieval Evidence**: Every query and its associated results are cryptographically signed with an Ed25519 keypair.
* **Integrity Validation**: The `/compliance/export` endpoint allows auditors to verify that the retrieved context matches the original database entries, preventing "hallucinated audit trails" or silent database tampering.

---

## 3. User Interpretation & Human Oversight (Article 13(4))
To prevent over-reliance on AI outputs ("automation bias"), developers and operators must be able to inspect the background knowledge of the AI.

* **Source Reliability Signal**: ScopeKeep tracks technical source identifiers through `agent_stats`. These identifiers must represent software agents, not employees, and must not be used for worker scoring or employment decisions.
* **Trust Filtering**: The retrieval algorithm prioritizes facts from agents with higher reputation scores, while penalizing or filtering out memories from agents with frequent contradictions.
