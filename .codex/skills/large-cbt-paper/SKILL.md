---
name: large-cbt-paper
description: Reference for the paper "Concurrent Binary Trees for Large-Scale Game Components" (Benyoub & Dupuy, HPG 2024, arXiv:2407.02215). Use when working on CBT terrain tessellation, bisector subdivision, halfedge initialization, GPU update kernels, memory pool management, or any code under src/systems/lod/cbt/.
---

# Large CBT Paper Reference

Complete technical reference for the Concurrent Binary Tree paper that underpins World42's CBT terrain system.

## When to use

- Implementing or debugging CBT split/merge logic (`cbt_state.ts`, `cbt_classify.ts`)
- Understanding bisector vertex computation and subdivision matrices
- Working on the 9-kernel GPU update pipeline
- Optimizing memory allocation for the bisector pool
- Understanding compatibility chains and conforming triangulations
- Comparing World42's CPU/WASM approach against the paper's GPU-native design

## Resources

- `references/paper.md` — Full paper content in markdown (sections, algorithms, equations, performance data)
- GitHub reference implementation: https://github.com/AnisB/large_cbt
- arXiv: https://arxiv.org/abs/2407.02215
