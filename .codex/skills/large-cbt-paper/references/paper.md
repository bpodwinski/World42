# Concurrent Binary Trees for Large-Scale Game Components

**Authors:** Anis Benyoub, Jonathan Dupuy
**Venue:** High Performance Graphics 2024
**arXiv:** [2407.02215](https://arxiv.org/abs/2407.02215)
**Reference implementation:** https://github.com/AnisB/large_cbt

---

## Abstract

We leverage concurrent binary trees (CBT) — a GPU-friendly data structure — to generate adaptive terrain tessellations in real time. We extend bisection-based tessellations from square domains to arbitrary polygon meshes using a triangular subdivision primitive called a "bisector," and enable higher subdivision levels by repurposing CBT as a memory pool manager. We demonstrate the approach by rendering planetary-scale geometry out of very coarse meshes in under 0.2 ms on console hardware.

---

## 1. Introduction

Terrain rendering requires adaptive tessellation that transitions smoothly from centimeter-level detail at ground level to planetary scale in orbit. Existing approaches have limitations:

- **Clipmaps:** Difficult altitude-dependent balancing
- **Projected grids:** Artifacts during static geometry flythrough
- **CPU-based adaptive grids:** Limited to coarse resolutions

This paper combines three established methodologies:
- **ROAM** (Real-time Optimally Adapting Meshes): incremental refinement/decimation framework
- **Newest Vertex Bisection:** ensures conforming triangulations through compatibility chains
- **Halfedge Mesh Representation:** enables topologically-preserving subdivision

---

## 2. Background: Bisection-Based Tessellations

### 2.1 Bisector Notation

Each subdivision element is denoted **b_j^d**, where:
- **d** = subdivision depth
- **j** = unique identifier within that level (binary index)

### 2.2 Bisector Operators

Each bisector supports three neighborhood operators:
- **Next(b):** next bisector in the triangulation
- **Prev(b):** previous bisector
- **Twin(b):** bisector sharing the longest edge (may be null at boundaries)

### 2.3 Subdivision Matrices

Refinement splits a bisector into two children using matrices:

```
M_0 = | 1   0   0 |     M_1 = | 0   0   1 |
      | 0   0   1 |           | 0   1   0 |
      | 1/2 1/2 0 |           | 1/2 1/2 0 |
```

For bisector b_j^d, vertices are computed as:

```
V_new = M * V_root
```

where M is the composition of matrices determined by the binary representation of j:

```
M = Product( M_{bit_i} ) for each bit in binary(j)
```

This enables O(d) vertex decompression from any bisector's index without tree traversal.

### 2.4 Compatibility Chains

Newest vertex bisection requires bisectors sharing an edge to maintain consistent subdivision levels (differ by at most 1). The Twin operator identifies these relationships, and refinement enforces constraints through recursive propagation.

---

## 3. Halfedge-Based Initialization

### 3.1 Mapping Halfedges to Root Bisectors

Each halfedge of the input mesh maps to one root bisector. For a halfedge h:

- **Vertex 0** = Vert(Next(h))
- **Vertex 1** = Vert(Prev(h))
- **Vertex 2** = Vert(h)

This preserves the input mesh topology and enables bisection-based tessellation on arbitrary polygon meshes (not just quads).

### 3.2 Neighborhood Initialization

Root bisector neighborhood operators are derived from halfedge operators:

- **Next(b_root)** = bisector of Next(h)
- **Prev(b_root)** = bisector of Prev(h)
- **Twin(b_root)** = bisector of Twin(h) (null if boundary)

---

## 4. Subdivision Operations

### 4.1 Refinement (Algorithm 3)

Implements newest vertex bisection:

1. Check if Twin bisector exists and is at a coarser level
2. If so, recursively refine Twin first (compatibility chain)
3. Split the bisector into two children (left = b_{2j}^{d+1}, right = b_{2j+1}^{d+1})
4. Update neighborhood pointers:
   - Next(b_{2j}^{d+1}) = b_{2j+1}^{d+1}
   - Prev relationships reorganize through conditional logic
   - Twin relationships redistribute between parent and children

### 4.2 Decimation (Conservative Merge)

Only merges bisectors in two safe configurations:

1. **Interior cycle:** Four same-depth bisectors forming a closed Next-cycle
2. **Boundary pair:** Two same-depth bisectors where one or both have null Twin

This ensures the triangulation remains conforming after every merge.

### 4.3 Vertex Computation (Algorithm 2)

Reconstructs any bisector's geometry in O(d) steps:

1. Compute index chain from bisector ID to root
2. Compose subdivision matrices along this chain
3. Multiply composed matrix with root bisector vertices

The binary index j directly encodes which matrix sequence (M_0 or M_1) generates a given bisector's geometry.

---

## 5. CBT as Memory Pool Manager

### 5.1 Original CBT Structure

A full binary tree with:
- **Leaf bits:** track memory block allocation status (1 = allocated, 0 = free)
- **Interior nodes:** store cumulative sums enabling O(D) binary searches

### 5.2 Memory Layout

Binary heap in contiguous array of size 2^(D+1):
- Child of node k at indices 2k and 2k+1
- Parent at floor(k/2)
- Eliminates explicit pointer storage

### 5.3 Key Algorithms

**Algorithm 7 — OneToBitID:** Locates the i-th set bit in O(D) operations through binary search across sum-reduction tree values. Used to find allocated bisectors.

**Algorithm 8 — ZeroToBitID:** Finds the i-th unset bit using inverted logic. Essential for allocating new memory blocks.

### 5.4 Advantage Over Implicit Encoding

The original CBT approach encodes the triangulation implicitly in the bitfield, limiting subdivision depth to D. By repurposing CBT as a memory manager, the bisector pool can store explicit neighbor pointers and arbitrary data, removing the depth limitation.

---

## 6. GPU Update Pipeline (9 Kernels)

The per-frame update executes 9 compute kernels in sequence:

| # | Kernel | Purpose |
|---|--------|---------|
| 1 | **ResetCounter** | Initialize allocation tracking counter to 0 |
| 2 | **CachePointers** | Precompute block indices via Algorithms 7-8 |
| 3 | **ResetCommands** | Clear refinement/decimation command flags |
| 4 | **GenerateCommands** | Decide per-bisector split/merge based on screen-space metrics |
| 5 | **ReserveBlocks** | Atomically allocate memory pool locations |
| 6 | **FillNewBlocks** | Write computed bisector data to reserved blocks |
| 7 | **UpdateNeighbors** | Scatter pointer updates to affected neighbors |
| 8 | **UpdateBitfield** | Reflect allocation changes in CBT bitfield |
| 9 | **SumReduction** | Recompute cumulative counts for next frame |

### 6.1 Thread Scheduling

`DispatchIndirect` uses the CBT root value (total allocated blocks) to determine thread counts. This enables dynamic scaling: as geometry refines, more threads activate automatically.

### 6.2 Atomic Operations

Critical sections employ:
- **AtomicAdd** for allocation counter (ensures unique block assignment)
- **AtomicOr** for command flags (allows multiple refinement requests to coexist)
- **AtomicDec** for memory overflow protection

---

## 7. Memory Requirements

### 7.1 Per-Bisector Storage (9 integers)

| Field | Size | Purpose |
|-------|------|---------|
| Next pointer | 1 int | Neighborhood |
| Prev pointer | 1 int | Neighborhood |
| Twin pointer | 1 int | Neighborhood |
| Index value | 1 int | Vertex decompression |
| Command bitfield | 1 int | Split/merge flags |
| Reserved blocks | 4 int | Allocated locations for children/neighbors |

### 7.2 Whole-System Allocation

| Buffer | Size |
|--------|------|
| Halfedge buffer | 6 integers per edge |
| Vertex buffer | 3 floats per vertex |
| Bisector pool | 2^D elements x 9 integers |
| CBT | 2^(D+1) elements |
| Allocation counter | 1 integer |
| Pointer buffer | 2^D elements x 2 integers |

### 7.3 Worst-Case Allocation

Compatibility chains can require up to **3d + 4** allocations at depth d during a single refinement operation.

---

## 8. Performance Results

### 8.1 Planetary Rendering

- **Base mesh:** 12-face dodecahedron (60 halfedges)
- **Dynamic water:** Four FFT-synthesized wave layers
- **Scale range:** Ground-level to space (10+ orders of magnitude)
- **Tessellation time:** < 0.2 ms per frame
- **Hardware:** Mid-range GPU (PlayStation 5 equivalent)
- **Detail:** Centimeter precision on Earth-sized geometry

### 8.2 Surface Gradient Normals

The reference implementation computes normals via **surface gradients**:

1. **Compute shader** (`EvaluateSurfaceGradients.compute`): reads elevation texture, samples center + 2 neighbors, computes cross product for perturbed normal, stores as surface gradient
2. **Detail slopes** via 4-neighbor finite differences: `(right - left)` in x, `(down - up)` in y
3. **Multi-band accumulation** (`sg_utilities.hlsl`): 4 frequency bands with distance-based attenuation
4. **Normal reconstruction:** `normal = normalize(float3(0, 1, 0) - totalSurfaceGradient)`
5. **Local-frame rotation** via multiplication matrix

---

## 9. Comparison With World42 Implementation

| Aspect | Paper (GPU-native) | World42 (CPU/WASM) |
|--------|-------------------|-------------------|
| Bisector storage | GPU buffer, 9 ints/bisector | `CbtState` TypeScript class |
| Subdivision | 9 GPU compute kernels | `cbt_state.ts` split/merge methods |
| Vertex computation | GPU Algorithm 2 (matrix composition) | Workers via `build_triangle_chunk` |
| Memory management | CBT bitfield + sum-reduction | JavaScript Map + retiring mesh list |
| Normals | Surface gradients in compute shader | Surface gradients in Rust WASM |
| Thread scheduling | DispatchIndirect from CBT root | WorkerPool with priority queue |
| Performance target | < 0.2 ms GPU | Frame-budget scheduler (2-4 ms) |

### 9.1 Key Differences

1. World42 runs terrain generation on **CPU workers** (Rust/WASM), not GPU compute
2. World42 uses **explicit mesh generation** per leaf (positions, indices, UVs), not GPU-side vertex decompression
3. World42's CBT state is a **simplified binary tree** without the full halfedge/bisector machinery
4. Surface gradient computation follows the paper's approach but uses **central differences in Rust** instead of GPU texture sampling

### 9.2 Migration Path to GPU

To move closer to the paper's GPU-native approach:
1. Implement bisector pool as a WebGPU storage buffer
2. Port the 9-kernel pipeline to WebGPU compute shaders
3. Use CBT sum-reduction for DispatchIndirect thread counts
4. Compute vertices on-the-fly via matrix composition (Algorithm 2) instead of precomputing in workers
