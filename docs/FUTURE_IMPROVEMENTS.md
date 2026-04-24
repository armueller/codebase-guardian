# Future Improvements

Deferred items from code reviews and brainstorming sessions.

## Security: Hardened Sandbox for Execute Tool

**Source:** PR #1 code review (Copilot, 2026-04-24)

The `execute` tool uses `node:vm` which is not a security boundary. Host objects passed into the context can be escaped via `someFn.constructor.constructor(...)`. Current threat model is benign (code authored by Claude, not untrusted users), so `vm` is sufficient.

If the execute tool is ever exposed to untrusted input, consider:
- `isolated-vm` package for true V8 isolate sandboxing
- Separate worker process with IPC API
- Defensively freezing/isolating all exposed objects

## Test Reliability: Embedding Model in CI

**Source:** PR #1 code review (Copilot, 2026-04-24)

The `IndexAPI — semantic search` tests in `tests/index-api.test.ts` call `generateEmbeddings()`, which lazy-loads `@huggingface/transformers` and may trigger a model download (~30MB) on first run. This makes the test suite depend on network/model cache state.

Options when CI is added:
- Skip semantic search tests when model unavailable (`{ skip: !modelAvailable }`)
- Inject a stub embedding implementation for deterministic tests
- Pre-cache the model in the CI image
