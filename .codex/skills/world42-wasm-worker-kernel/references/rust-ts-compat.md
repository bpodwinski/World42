# Rust TS Compatibility

## Function signature alignment

Current TS worker call order must match Rust `build_chunk(...)` exactly:

1. `uMin`
2. `uMax`
3. `vMin`
4. `vMax`
5. `resolution`
6. `radius`
7. `face`
8. `seed`
9. `octaves`
10. `baseFrequency`
11. `baseAmplitude`
12. `lacunarity`
13. `persistence`
14. `globalTerrainAmplitude`

If Rust order changes, update TS call sites immediately.

## Output shape alignment

Rust returns JS object keys consumed by TS:
- `positions`
- `normals`
- `uvs`
- `indices`
- `boundsInfo`

`boundsInfo` subkeys required by TS culling:
- `centerLocal`
- `boundingRadius`
- `minPlanetRadius`
- `maxPlanetRadius`

## Typed arrays and transfers

- `typed` mode expects `Float32Array` for positions/normals/uvs.
- `indices` can be `Uint16Array` or `Uint32Array`.
- Worker transfer list must include all four buffers in typed mode.
- `arrays` mode must clone to plain arrays before postMessage.

## Safety checks to preserve

- Runtime shape guard: `isChunkMeshData`
- Runtime typed guard: `isTypedMeshData`
- Cancellation guard with `currentJobId` and `cancelCurrent`

## Testing touchpoints

- `src/systems/lod/workers/worker_protocol.test.ts`
- Any tests that assert protocol constants or message shapes
