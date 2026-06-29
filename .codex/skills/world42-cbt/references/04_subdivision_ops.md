# Subdivision operators (refine/decimate) — distilled

## Bisector identification and vertex decoding
Each bisector carries an integer code (call it `j` in the paper) that allows decoding its vertices as:

- Identify the root halfedge = `root = j >> d` (conceptually “j divided by 2^d”)
- Reconstruct a **subdivision matrix** by walking up bits of `j` (lowest bit selects which split matrix applies)
- Apply that matrix to the root bisector vertices

The paper defines two 3×3 refinement matrices, one for the “first child” and one for the “second child”.
At each refinement step, one matrix is chosen based on whether the current step is a left/right child (bit 0/1).

### Practical takeaway for engine work
- You can decode bisector triangle positions procedurally in the shader (or compute) from:
  (root halfedge ID, child-bit path).
- This avoids storing explicit geometry for deep levels.

## Adaptive refinement (ROAM-style)
Refining bisector `bj`:
1) let `bk = Twin(bj)`  
2) if `bk` exists and is not mutually compatible (Twin(bk) != bj), first refine `bk` recursively
3) split `bj` (and `bk` if non-boundary) into children

This recursion builds the **compatibility chain** automatically.

## Conservative decimation
Instead of “perfect inverse” decimation (which can be ambiguous under concurrent refinement),
the paper uses a conservative rule that only merges when safe:
- merge **four** same-level bisectors that form a cycle (non-boundary case), into two coarser ones
- merge **two** border bisectors (Twin = null) into one coarser one (boundary case)

## Neighbor pointer maintenance
Refinement and decimation require updating neighbor pointers so every active bisector points to correct Next/Prev/Twin.
The paper provides deterministic pointer rewrite rules for:
- splitting a bisector: neighbors that used to point to the parent should now point to the appropriate child
- merging children: neighbors should be redirected to the coarser parent

### Practical takeaway
If you adopt this in World42:
- store neighbor pointers in a pool array
- after creating children, perform a separate “scatter” pass to update neighbors (avoid write conflicts)
- keep the rules purely local (only touching the active bisector and immediate neighbors)
