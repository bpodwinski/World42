# Executive summary (for World42)

The paper proposes a **GPU-only adaptive triangulation** scheme for large-scale game components (terrain, water, planets).
It generalizes ROAM-style bisection from square domains to **arbitrary halfedge meshes** by attaching a subdivision primitive (“bisector”)
to each **halfedge** of the input mesh.

Key improvement over earlier CBT work:
- the **Concurrent Binary Tree (CBT)** is not used as an implicit encoding of subdivision depth;
  instead it is used as a **memory pool manager** for a fixed-size array of bisectors.
- this decouples *subdivision depth* from *CBT depth*, enabling very deep refinement (up to ~64 levels using a 64-bit bisector index),
  while keeping the CBT small (e.g., depth 17 → 128k pool elements).

The system runs as a **progressive / incremental update**:
each frame, existing bisectors decide to refine, decimate, or stay, with local operations guaranteeing a conforming triangulation at all times.

Reported results:
- adaptive update cost under ~0.1 ms per frame on an AMD 6800 XT-class GPU (console-level)
- planetary rendering with centimeter-level detail and a single representation
- example memory footprint ~7 MiB for a 128k bisector pool (depth D=17 CBT), using 32-bit pointers + 64-bit bisector indices.

For World42:
- This paper is directly relevant to replacing/augmenting CPU quadtree/CDLOD with a GPU resident, topologically general triangulation.
- It also provides concrete guidance on precision: fp64 may be required for vertex evaluation at planetary scale unless you adopt quantization + floating origin carefully.
