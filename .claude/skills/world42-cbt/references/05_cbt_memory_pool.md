# CBT as memory pool manager (GPU-friendly)

## Data structure
A CBT of depth D:
- has 2^D leaves (bitfield)
- total nodes stored as an array of size 2^(D+1)
- heap layout:
  - children of node k are at 2k and 2k+1
  - parent of node k is at floor(k/2)

Leaves map 1:1 to blocks in a fixed-size pool of capacity 2^D.

Convention:
- bit = 1 → allocated block
- bit = 0 → free block
Root of the sum-reduction stores the number of allocated blocks.

## Key operations
### A) Find i-th allocated block (i-th set bit)
Use the sum-reduction values to descend from the root:
- go left if i < leftCount
- else i -= leftCount and go right
Repeat until reaching a leaf.

This is O(D).

### B) Find i-th free block (i-th zero bit)
Same descent but using “freeCount = subtreeCapacity - allocatedCount”.

Also O(D).

## Parallel update pattern
Two-phase approach:
1) For each active block (thread per allocated item):
   - optionally request allocations: atomically increment a counter to reserve a “rank” in free blocks
   - locate each reserved free block via “i-th zero bit” and set its bit to 1
   - optionally free current block by setting its bit to 0
2) Rebuild sum-reduction tree (parallel reduction up the CBT).

This turns the CBT into both:
- a **compact iterator** over active items
- a **concurrent allocator** for new items
