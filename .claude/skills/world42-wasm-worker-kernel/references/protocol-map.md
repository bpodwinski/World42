# Protocol Map

## Version

- Constant: `MESH_KERNEL_PROTOCOL = "mesh-kernel/1"`
- Location: `src/systems/lod/workers/worker_protocol.ts`

## Requests

- `init`
  - payload: empty object
- `build_chunk`
  - payload:
    - `bounds` (`uMin`, `uMax`, `vMin`, `vMax`)
    - `resolution`, `radius`, `face`, `level`, `maxLevel`
    - `noise` (`seed`, `octaves`, `baseFrequency`, `baseAmplitude`, `lacunarity`, `persistence`, `globalTerrainAmplitude`)
    - `meshFormat` (`typed` or `arrays`)
- `cancel`
  - payload: `cancelId`

## Responses

- `ready`
  - payload: `impl`, `meshFormats`
- `chunk_result`
  - payload: `meshData`, optional `stats`
- `error`
  - payload: `code`, `message`

## Error codes in current worker path

- `wasm_init_failed`
- `cancelled`
- `exception`
- `protocol_error`
- `worker_error`

## Contract rules

- Keep request and response `kind` discriminants exact.
- Keep protocol constant centralized in `worker_protocol.ts`.
- Update `isMeshKernelMessage` tests when protocol shape evolves.
