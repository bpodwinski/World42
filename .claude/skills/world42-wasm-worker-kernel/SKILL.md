---
name: world42-wasm-worker-kernel
description: Maintain and evolve the World42 terrain mesh kernel contract between TypeScript worker protocol, worker runtime, and Rust/WASM generator outputs. Use when changing src/systems/lod/workers/worker_protocol.ts, terrain_mesh_worker.ts, chunk_forge.ts, terrain/src/lib.rs, or any message format, typed array transfer, cancellation, and mesh payload schema behavior.
---

# World42 Wasm Worker Kernel

Change the mesh kernel safely by keeping Rust output shape, worker protocol types, and transfer behavior aligned. Treat protocol/schema edits as cross-file changes, never single-file edits.

## Workflow

### 1) Audit the current contract

Run:

```powershell
./.codex/skills/world42-wasm-worker-kernel/scripts/audit-kernel-contract.ps1
```

Collect:
- Protocol version and message kinds
- Build request payload fields and defaults
- WASM `build_chunk` argument order
- Mesh data shape and transfer list expectations

### 2) Apply changes across all contract layers

If you change protocol or payload fields, update together:
- `src/systems/lod/workers/worker_protocol.ts`
- `src/systems/lod/workers/terrain_mesh_worker.ts`
- `src/systems/lod/chunks/chunk_forge.ts`
- `src/systems/lod/workers/worker_pool.ts` when error semantics change
- `terrain/src/lib.rs` when WASM function signature or output changes

Never bump `MESH_KERNEL_PROTOCOL` without updating producer and consumer in the same change.

### 3) Keep compatibility invariants

- `meshFormat` handling must match actual payload type.
- Typed transfer must include all detached buffers.
- `boundsInfo` keys remain stable (`centerLocal`, `boundingRadius`, `minPlanetRadius`, `maxPlanetRadius`).
- Cancel/error paths must remain deterministic (`cancelled`, `exception`, `wasm_init_failed`).

### 4) Verify

- Run `npm run test` for protocol tests.
- If Rust/WASM changed, rebuild terrain package and verify worker init path still resolves.
- Ensure `isMeshKernelMessage` and related tests still reflect the new schema.

Use `references/protocol-map.md` and `references/rust-ts-compat.md` as the source of truth.

## Resources

- Script: `scripts/audit-kernel-contract.ps1`
- Reference: `references/protocol-map.md`
- Reference: `references/rust-ts-compat.md`
