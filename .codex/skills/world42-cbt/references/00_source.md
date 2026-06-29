# Source

- **Title:** Concurrent Binary Trees for Large-Scale Game Components (Benyoub, Dupuy, 2024)
- **Venue:** Proc. ACM Comput. Graph. Interact. Tech., Vol. 7, No. 3 (July 2024); author version on arXiv:2407.02215v1
- **Topic:** GPU-only adaptive triangulation for large-scale components (terrain/ocean/planet) using halfedge-based bisection + CBT memory pool.

## What to cite inside your project
Use this paper as reference for:
- halfedge-driven bisection “bisectors” on arbitrary polygon meshes
- refinement via *compatibility chains* (ROAM-style newest-vertex bisection)
- CBT used as **GPU memory pool manager** (decouples subdivision depth from CBT depth)
- incremental GPU update pipeline (multi-kernel, persistent triangulation updates)
- performance and memory sizing guidance (≈0.1 ms update, ~7 MiB example pool)

## Canonical figures / tables (for quick lookup)
- **Fig. 1:** Earth-sized planet rendered in real-time; shows zoom from ground to space
- **Fig. 2:** Halfedge mesh operators (Twin/Next/Prev/Vert/Edge/Face)
- **Fig. 3–4:** Root bisectors, adaptive bisection, compatibility chain propagation
- **Fig. 5:** CBT layout (bitfield + sum-reduction tree) + heap array layout
- **Fig. 6:** GPU update loop (9 compute kernels + barriers)
- **Table 2:** Memory buffers and element widths
- **Table 3:** Bench timings on AMD 6800 XT
- **Fig. 9:** fp64 vs fp32 precision artifacts at planetary scale
