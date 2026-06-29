# large_cbt GPU Reference — Mapping DX12/HLSL → WebGPU/WGSL

**Source**: https://github.com/AnisB/large_cbt  
**Paper**: Concurrent Binary Trees for Large-Scale Game Components (HPG 2024)  
**arXiv**: https://arxiv.org/abs/2407.02215  
**Tech stack in repo**: DirectX 12 · HLSL Shader Model 6.6 · C++  
**Tech stack in World42**: WebGPU · WGSL · TypeScript

---

## 1. CBT Memory Layout

Two GPU buffers per CBT instance:

### Buffer 0 — Packed Hierarchy Tree (prefix-sum tree)
Stores cumulative bit counts per level to allow O(log N) decode of the k-th active element.

```
Level 0  : 1 × u32    (root count)
Level 1  : 2 × u32
...
Level k  : 2^k × u{variable}   (32/16/8 bits depending on depth)
```

**World42 equivalent**: `storage` buffer of `array<u32>`.  
The level offsets and bit-widths are pre-computed constants per CBT size.

### Buffer 1 — Bitfield
One bit per potential triangle leaf: `1 = active`, `0 = free`.

```
bitfield[i / 64] |= (1uLL << (i % 64))   // HLSL syntax
```

**World42 equivalent**: `storage` buffer of `array<u32>` (WGSL has no `u64` — use two `u32` per slot or pack differently).

### Sizes

| Variant | Elements | Tree   | Bitfield | Total  |
|---------|----------|--------|----------|--------|
| 128K    | 131 072  | ~6.5 KB | 16 KB  | 22.5 KB |
| 256K    | 262 144  | ~13 KB  | 32 KB  | 45 KB  |
| 512K    | 524 288  | ~26 KB  | 64 KB  | 90 KB  |
| 1M      | 1 048 576| ~51 KB  | 128 KB | 179 KB |

---

## 2. Root Signature / Bind Group Layout

The repo uses these bindings (translate each to a WebGPU `@binding`):

| Slot name | Type | Description |
|-----------|------|-------------|
| `CBT_BUFFER0` | storage RW | Packed hierarchy tree |
| `CBT_BUFFER1` | storage RW | Bitfield |
| `HEAP_ID_BUFFER` | storage RW | Triangle ID → heap slot mapping |
| `BISECTOR_DATA_BUFFER` | storage RW | Per-element: subdivision pattern, state, flags |
| `NEIGHBORS_BUFFER` | storage RW | 3 half-edge neighbors per triangle |
| `CLASSIFICATION_BUFFER` | storage RW | LOD decision per triangle (BISECT/SIMPLIFY/UNCHANGED) |
| `ALLOCATION_BUFFER` | storage RW | Atomic counters for memory reservation |
| `PROPAGATE_BUFFER` | storage RW | Propagation queues for conformity cascades |
| `INDIRECT_DRAW_BUFFER` | storage RW | Indirect draw arguments (triangle count) |
| `INDIRECT_DISPATCH_BUFFER` | storage RW | Indirect dispatch arguments |
| `VISIBILITY_INDICES` | storage RW | Output: indices of visible triangles for rasterizer |
| `MODIFIED_INDICES` | storage RW | Output: indices of modified triangles |

**World42 note**: WebGPU supports `indirect` draw/dispatch. Map `INDIRECT_DRAW_BUFFER` to `GPUBuffer` with `INDIRECT` usage.

---

## 3. The Compute Kernel Pipeline

Executed every frame in this order (each is a separate compute dispatch):

```
Reset
  └─> Classify
        └─> Split
              └─> Allocate
                    └─> Bisect
                          └─> PropagateBisect
                                └─> PrepareSimplify
                                      └─> Simplify
                                            └─> PropagateSimplify
                                                  └─> ReducePrePass
                                                        └─> ReduceFirstPass
                                                              └─> ReduceSecondPass
                                                                    └─> BisectorIndexation
                                                                          └─> PrepareBisectorIndirect
```

### Kernel details

| Kernel | What it does | Key HLSL entry in repo |
|--------|-------------|------------------------|
| `Reset` | Clear counters, allocation buffer, indirect args | `UpdateMesh.compute` |
| `Classify` | For each active leaf: compute screen-space area, frustum cull, backface cull → write BISECT / SIMPLIFY / UNCHANGED to CLASSIFICATION_BUFFER | `UpdateMesh.compute` |
| `Split` | For each BISECT leaf: check neighbor conformity, atomically reserve a heap slot via `InterlockedAdd` | `UpdateMesh.compute` |
| `Allocate` | Mark newly reserved bits in CBT bitfield using `InterlockedOr` | `UpdateMesh.compute` |
| `Bisect` | Write child triangle data (vertices, neighbors, subdivision pattern) for each allocated slot | `UpdateMesh.compute` |
| `PropagateBisect` | Cascade forced splits to neighbors to avoid T-junctions | `UpdateMesh.compute` |
| `PrepareSimplify` | Mark sibling pairs eligible for merge | `UpdateMesh.compute` |
| `Simplify` | Clear bits in CBT bitfield for merged elements using `InterlockedAnd` | `UpdateMesh.compute` |
| `PropagateSimplify` | Cascade conformity during coarsening | `UpdateMesh.compute` |
| `ReducePrePass` | Count active bits per 64-bit bitfield word | `UpdateMesh.compute` |
| `ReduceFirstPass` | First level of prefix-sum tree reduction | `UpdateMesh.compute` |
| `ReduceSecondPass` | Complete reduction to root; tree ready for decode | `UpdateMesh.compute` |
| `BisectorIndexation` | Write indices of visible triangles to VISIBILITY_INDICES | `UpdateMesh.compute` |
| `PrepareBisectorIndirect` | Fill indirect draw/dispatch argument buffers | `UpdateMesh.compute` |

---

## 4. Key Algorithms (with HLSL → WGSL translation notes)

### 4.1 Decode k-th active element (tree traversal)

Used to find the actual triangle ID for the k-th active bit. O(log N).

```hlsl
// HLSL (ocbt_generic.hlsl)
uint decode_bit(uint k) {
    uint node = 0;
    for (uint level = 0; level < MAX_DEPTH; level++) {
        uint left_count = get_heap_element(2 * node + 1);  // left child prefix sum
        if (k < left_count) node = 2 * node + 1;
        else { k -= left_count; node = 2 * node + 2; }
    }
    return node - (1u << MAX_DEPTH) + 1;  // convert to leaf index
}
```

```wgsl
// WGSL equivalent
fn decode_bit(k: u32) -> u32 {
    var node = 0u;
    var remaining = k;
    for (var level = 0u; level < MAX_DEPTH; level++) {
        let left_count = get_heap_element(2u * node + 1u);
        if (remaining < left_count) {
            node = 2u * node + 1u;
        } else {
            remaining -= left_count;
            node = 2u * node + 2u;
        }
    }
    return node - (1u << MAX_DEPTH) + 1u;
}
```

### 4.2 Bit set / clear (bitfield)

```hlsl
// HLSL — 64-bit atomic (Shader Model 6.6)
InterlockedOr(_BitfieldRW[bitID / 64], 1uLL << (bitID % 64));
InterlockedAnd(_BitfieldRW[bitID / 64], ~(1uLL << (bitID % 64)));
```

```wgsl
// WGSL — no u64; split into two u32 slots
fn set_bit(bit_id: u32) {
    let slot = bit_id / 32u;
    let local = bit_id % 32u;
    atomicOr(&bitfield[slot], 1u << local);
}
fn clear_bit(bit_id: u32) {
    let slot = bit_id / 32u;
    let local = bit_id % 32u;
    atomicAnd(&bitfield[slot], ~(1u << local));
}
```

**Note**: WGSL `atomicOr`/`atomicAnd` require the buffer to use `atomic<u32>`. Declare as `var<storage, read_write> bitfield: array<atomic<u32>>`.

### 4.3 Screen-space area LOD metric

```hlsl
// HLSL (from Classify kernel, update_utilities.hlsl)
float3 centroid = (v0 + v1 + v2) / 3.0;
float3 cam_vec = centroid - camera_pos;
float dist_sq = dot(cam_vec, cam_vec);
float3 e0 = v1 - v0, e1 = v2 - v0;
float world_area = length(cross(e0, e1)) * 0.5;
float projected_area_px2 = world_area * focal_length_sq / dist_sq;
```

This is **identical** to what `cbt_classify.ts` already implements — this part of World42 is correct.

### 4.4 Sum-reduction (prefix sum tree rebuild)

```hlsl
// ReducePrePass: count bits in each u64 bitfield word
uint64_t word = _BitfieldRW[thread_id];
_TreeRW[offset + thread_id] = countbits(word);  // popcount

// ReduceFirstPass / ReduceSecondPass: sum up the tree
_TreeRW[parent] = _TreeRW[left_child] + _TreeRW[right_child];
```

```wgsl
// WGSL equivalent
fn count_bits_u32(v: u32) -> u32 { return countOneBits(v); }

// ReducePrePass: per u32 slot
tree[offset + thread_id] = countOneBits(bitfield[thread_id]);

// ReducePass: bottom-up
tree[parent] = tree[left_child] + tree[right_child];
```

---

## 5. Neighbor Conformity (T-junction prevention)

The repo maintains a **half-edge neighbor table** (`NEIGHBORS_BUFFER`): each triangle stores the 3 adjacent triangle IDs (across the 3 edges).

Before bisecting triangle T, the kernel checks if T's neighbors at the shared longest-edge are already at depth ≥ T or will be forced to split. This is the `PropagateBisect` kernel.

**World42 current state**: `CbtState` stores triangles in a `Map` with no neighbor tracking → T-junctions can appear at level transitions. Implementing `NEIGHBORS_BUFFER` is required for crack-free rendering.

---

## 6. Shared Memory / LDS Optimization

The repo caches parts of the CBT tree in LDS (group-shared memory) per workgroup:

```hlsl
groupshared uint gs_cbt_cache[OCBT_SHARED_MEMORY_SIZE];
```

This avoids global memory bandwidth during tree traversal within a workgroup.

**WGSL equivalent**: `var<workgroup> cbt_cache: array<u32, OCBT_SHARED_MEMORY_SIZE>;`

Max workgroup shared memory in WebGPU: **16 KB** (guaranteed minimum). Plan LDS usage accordingly.

---

## 7. What to Implement in World42 (Priority Order)

| Priority | Task | Source in repo |
|----------|------|---------------|
| P1 | Replace `Map<id,CbtNode>` with heap-layout `Uint32Array` (typed array) | `ocbt_generic.h` |
| P2 | Implement bitfield as `Uint32Array` (1 bit per leaf) | `ocbt_generic.hlsl` |
| P3 | Implement sum-reduction (prefix-sum tree) in TypeScript | `ReducePrePass/FirstPass/SecondPass` |
| P4 | Add neighbor table (`NEIGHBORS_BUFFER`) for crack-free splits | `NEIGHBORS_BUFFER` binding |
| P5 | Port Classify + Split + Allocate + Bisect to WebGPU compute shaders | `UpdateMesh.compute` |
| P6 | Port Reduce passes to WebGPU compute shaders | `UpdateMesh.compute` |
| P7 | Switch to indirect draw (`GPUBuffer` INDIRECT usage) | `INDIRECT_DRAW_BUFFER` |

Steps P1–P4 are pure TypeScript (no WebGPU yet) and fix the structural gap in the current implementation. Steps P5–P7 unlock full GPU performance.

---

## 8. Differences from Current World42 CBT

| Aspect | large_cbt (paper) | World42 CBT (current) |
|--------|------------------|-----------------------|
| Data structure | Typed array heap + bitfield | `Map<number, CbtNode>` |
| Sum-reduction | 3 GPU reduction passes | None |
| Split/merge | GPU atomic (InterlockedAdd/Or/And) | CPU loop |
| Neighbor tracking | Half-edge table (crack-free) | None (T-junctions possible) |
| Mesh output | Indirect GPU draw | CPU `emitMeshFromLeaves()` |
| LOD metric | Screen-space area ✓ | Screen-space area ✓ |
| Bisection | Longest-edge ✓ | Longest-edge ✓ |
| Precision | FP64 optional | FP32 (Babylon Vector3) |

---

## 9. Repo Key Files Quick Reference

| File | What to read |
|------|-------------|
| `shaders/shader_lib/ocbt_generic.hlsl` | Core CBT ops: `set_bit`, `clear_bit`, `decode_bit`, `reduce` |
| `shaders/shader_lib/update_utilities.hlsl` | Full 14-kernel pipeline entry points |
| `shaders/UpdateMesh.compute` | Kernel dispatch setup, root signature |
| `demo/include/cbt/ocbt_generic.h` | C++ template: memory layout, level offsets, bit masks |
| `shaders/shader_lib/bisector.hlsl` | Bisector data structure, longest-edge split geometry |
| `shaders/shader_lib/leb.hlsl` | Long Edge Binary encoding (CBT node → triangle vertices) |
| `shaders/shader_lib/double_math.hlsl` | FP64 emulation in HLSL (relevant for planet-scale precision) |
