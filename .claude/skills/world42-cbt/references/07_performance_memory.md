# Performance and sizing notes

## Test scenes
- Water system on Earth-sized sphere (base mesh: regular dodecahedron)
- Moon terrain (NASA displacement map 5760×2880 + simplex noise)
- Complex arbitrary asset comparison vs tessellation shaders

## LOD target in examples
Triangles refined so that each triangle occupies ~49 pixels on screen (water/terrain scenes).

## Timings (AMD 6800 XT-class)
The paper reports, for the 9-kernel update:
- ~0.084–0.1 ms update time per frame on the tested scenes
Rendering costs depend on shading path (visibility buffer + shading vs forward).

## Memory footprint example
Using CBT depth D=17 (pool capacity 128k):
- 32-bit ints everywhere except **64-bit bisector index**
- reported total memory: ~7 MiB for planetary-scale triangulation (derived from their buffer table)

## Key scalability claim
Original CBT implementation ties maximum subdivision depth to CBT depth (e.g., D=27), which:
- limits refinement depth for planetary scale
- wastes memory (2^27 elements)
- makes sum reduction expensive (~0.4 ms reported bottleneck)

Their memory-pool CBT decoupling:
- achieves deeper subdivision (~64) with small CBT (D=17)
- reduces sum-reduction cost and total update time

## Precision evidence
Fig. 9 shows fp32 produces visible discretization artifacts at planetary scale; fp64 fixes it.
The paper notes quantization could be an alternative but not explored there.
