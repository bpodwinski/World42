# GPU update loop (9 kernels) — implementation recipe

The paper’s incremental update is a fixed sequence of compute kernels with barriers.

## Buffers (conceptual)
- Halfedge buffer (topology) — per halfedge: Twin/Next/Prev/Vert/Edge/Face (as ints)
- Vertex buffer (positions) — per vertex: float3 (or quantized)
- Bisector pool — per bisector: neighbor pointers + bisector index + command + reserved slots
- CBT array — bitfield + sum-reduction tree
- Allocation counter (atomic int)
- Pointer buffer — caches:
  - pointer to the t-th allocated block (for iteration)
  - pointer to the t-th free block (for allocation)

## Kernel sequence (rephrased from Fig. 6)
1) ResetCounter
   - set allocation counter to 0

2) CachePointers
   - for each threadID in [0 .. allocatedCount):
     - pointerBuf[threadID].allocated = find i-th set bit
     - pointerBuf[threadID].free      = find i-th zero bit   (cached for later)

3) ResetCommands
   - clear per-bisector command flags

4) GenerateCommands
   - decode bisector vertices
   - evaluate LOD metric (paper uses screen-space triangle area target)
   - if refine: mark split commands on the bisector + compatibility chain via atomic OR
               also reserve an upper bound of allocations; skip refine if pool too full
   - if decimate: check safe merge configuration; mark merge command
                  reserve up to 2 allocations if needed
   - else: leave as is

5) ReserveBlocks
   - for each bisector with a command, reserve N target blocks by atomically decrementing allocation counter,
     then map reserved ranks to free block IDs using the cached free pointers.
   - if both split and merge requested, prefer split (ignore merge)

6) FillNewBlocks
   - write newly created bisectors into reserved blocks:
     - set child indices
     - initialize partial neighbor pointers (local inheritance rules)

7) UpdateNeighbors
   - scatter pointer fixes to neighbors (local rewrite rules)

8) UpdateBitfield
   - free old blocks (bit=0) when command executed
   - mark newly allocated blocks (bit=1)

9) SumReduction
   - rebuild CBT internal nodes bottom-up

## LOD metric used in the paper
“screen-space triangle area” is used to decide refine/decimate so triangles are roughly constant size on screen.
This is a good fit for planetary zoom from ground to space.

## Precision note (important for World42)
The paper reports fp64 needed for world-space evaluation at planetary scale to avoid discretization artifacts (see Fig. 9).
In World42 you can often avoid fp64 in shaders by:
- evaluating in local patch coordinates
- applying floating origin (Render-space)
- using quantization / integer coordinates + scale
But you must be deliberate: mixed spaces will cause shimmering/cracks.
