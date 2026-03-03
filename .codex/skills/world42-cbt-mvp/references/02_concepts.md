# Key concepts and terminology

## Halfedge mesh (input topology)
The input is a **halfedge mesh**: each halfedge h has operators:
- **Twin(h)**: opposite halfedge across an edge (or null / -1 on boundaries)
- **Next(h), Prev(h)**: cycle within the face
- **Vert(h)**: vertex at the end (or start, depending on convention)
- **Edge(h), Face(h)**: topological owners

This representation gives local navigation in O(1), which is used to define subdivision consistently across arbitrary polygons.

## Bisector (subdivision primitive)
A **bisector** is the paper’s triangular primitive tied to a halfedge.
- Root level: one bisector per halfedge.
- Refinement: a bisector splits into two children via bisection.
- The triangulation is the set of all currently active bisectors.

Bisectors store:
- neighbor pointers: Next / Prev / Twin (pointing to other bisectors in the pool)
- a bisector “index” (a compact code used to decode vertices, not a memory address)
- a command field (split/merge requests)
- a few reserved target slots for newly allocated blocks (write targets during splitting/merging)

## Compatibility chain (conforming bisection)
To keep the mesh conforming, refining one bisector may require refining its Twin and recursively the Twin’s Twin, etc.
This produces a unique propagation path called the **compatibility chain** (ROAM/newest-vertex-bisection style).
Refinement is local but may propagate through this chain.

## Concurrent Binary Tree (CBT) used as a memory pool
CBT is a full binary tree stored as an array (binary heap layout).
- Leaves: a **bitfield** where bit i indicates whether memory block i is allocated (1) or free (0).
- Internal nodes: a **sum-reduction tree** over those bits; root stores number of allocated blocks.

Two key searches:
- find the i-th **set** bit (to iterate active blocks)
- find the i-th **zero** bit (to allocate free blocks)

The CBT enables parallel scheduling: “thread t processes the t-th allocated bisector”.

## Incremental GPU update
Per frame, the algorithm performs:
- decide per bisector: refine / decimate / keep
- allocate new blocks needed for splits/merges
- fill newly allocated bisector data
- update neighbor pointers
- update CBT bitfield + rebuild sum-reduction
