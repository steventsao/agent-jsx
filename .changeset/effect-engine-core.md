---
"@agent-jsx/core": minor
---

Add a compiler-owned Effect runtime while keeping authored agents plain and synchronous. Generated descriptors retain literal provides/requires information, fail closed on missing or cyclic dependencies, acquire shared resources once, and finalize them when their runtime is disposed. Promise-returning agent functions now fail loudly instead of compiling as an empty tree.

Publish the existing Effect-free durable-workflow API over the no-sharding in-memory Effect Workflow engine. Plain functions and `step.do` checkpoints receive deterministic execution ids and exactly-once replay within a host; a deployment adapter can replace the storage layer for restart durability. Effect is the only new runtime package and is pinned while its v4 API is pre-release.
