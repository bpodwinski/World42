# Implementation checklist (if you prototype this)

## Data preparation (CPU)
- Build a halfedge mesh for the base planet mesh (dodecahedron/icosahedron)
- Create integer arrays: Twin/Next/Prev/Vert/Face (+ optional Edge)
- Upload vertex positions (ideally in local planet coords)

## GPU buffers
- Allocate CBT array for chosen D (e.g., 17)
- Allocate bisector pool (2^D entries)
- Allocate pointer buffer (2^D entries of 2 ints)
- Allocate allocation counter

## Initialization
- Create H root bisectors (H = #halfedges) in first H pool slots
- Set first H bits = 1 in CBT bitfield; others = 0
- Build sum reduction tree

## Per-frame update loop (amortize if needed)
- Run 9 kernels in order with barriers
- In GenerateCommands:
  - decode triangle vertices
  - compute screen-space area (or error) metric
  - decide refine/decimate/keep with hysteresis

## Validation
- Visualize triangulation (wireframe)
- Stress zoom from ground to orbit (stability + no cracks)
- Compare fp32 vs fp64 for metric evaluation at large scales

## Risk notes
- WebGL2 compute is limited; full implementation is more natural in WebGPU
- Neighbor pointer races must be handled via command encoding + structured phases
- Memory pool overflow handling must be robust (skip refinement when pool full)
