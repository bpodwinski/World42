# Initialization: root bisectors from halfedges

## One root bisector per halfedge
For each halfedge h in the input mesh, create one root bisector b(0, h).

## Root bisector vertices
Each root bisector is represented by 3 vertices (v0, v1, v2):
- v0 = Vert(h)
- v1 = Vert(Next(h))
- v2 = average of all vertices around the face cycle starting from Next(h) until returning to h

This definition:
- works for arbitrary polygon faces (not only triangles/quads)
- preserves the input topology (important for animated assets)
- avoids the NP-hard “longest-edge bisection init” problem by using intrinsic halfedge structure.

### Rephrased pseudocode (root bisector vertices)
1) let h0 = h
2) set v0 = Vert(h0)
3) set v1 = Vert(Next(h0))
4) walk all halfedges of the face loop starting at Next(h0) and sum Vert(hi)
5) v2 = (sum / count)
6) return [v0, v1, v2]

## Neighboring root bisectors
Given a halfedge h, the neighboring bisectors are:
- Next neighbor: bisector mapped from Next(h)
- Prev neighbor: bisector mapped from Prev(h)
- Twin neighbor: bisector mapped from Twin(h) (or null at boundaries)

These neighbors are stored as pointers (indices) into the bisector pool.
