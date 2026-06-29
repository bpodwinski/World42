//! Bit-exact Rust port of CBT classification (src/systems/lod/cbt/cbt_classify.ts):
//! projected triangle area in px², backside cull (all 3 vertices), and frustum cull
//! (bounding sphere vs render-space planes). Produces the split-candidate list
//! (sorted desc by area) and merge-parent list (sorted asc by area).
//!
//! IMPORTANT: `focal` is passed IN (computed once on the main thread as
//! `viewportHeightPx / (2*tan(fov/2))`), NOT recomputed here — `tan` is the only
//! transcendental in this path and libm/JS may differ by an ULP, which could flip a
//! split decision at a threshold boundary and diverge the topology. Everything else
//! here is `+`/`*`/`sqrt`, so given the same focal the result is bit-identical to TS.

use crate::cbt::cbt_state::CbtLeaf;

const MIN_DISTANCE: f64 = 1.0;

/// Camera/view parameters for one classification pass (render matrix is the
/// planet render-parent world matrix, Babylon row-major `Matrix.m`).
pub struct ClassifyParams<'a> {
    pub camera_world: [f64; 3],
    pub planet_center_world: [f64; 3],
    pub render_mat: [f64; 16],
    pub focal: f64,
    pub split_threshold_px2: f64,
    pub split_hysteresis: f64,
    pub cull_backface: bool,
    pub cull_min_dot: f64,
    /// Render-space frustum planes as (nx,ny,nz,d); None disables the frustum cull.
    pub frustum_planes: Option<&'a [[f64; 4]]>,
    pub frustum_guard_scale: f64,
}

pub struct ClassifyResult {
    /// Leaf ids whose area exceeds the split threshold (and pass culls), desc by area.
    pub split_candidates: Vec<usize>,
    /// Parent ids eligible to merge (2 leaf children, below threshold), asc by area.
    pub merge_parents: Vec<usize>,
}

/// Babylon Vector3.TransformNormal: upper-left 3x3 of the row-major matrix.
#[inline]
fn transform_normal(c: [f64; 3], m: &[f64; 16]) -> [f64; 3] {
    [
        c[0] * m[0] + c[1] * m[4] + c[2] * m[8],
        c[0] * m[1] + c[1] * m[5] + c[2] * m[9],
        c[0] * m[2] + c[1] * m[6] + c[2] * m[10],
    ]
}

/// Inlined cross-product magnitude * 0.5 — same component order as the TS
/// `triangleArea` (load-bearing for matching projected areas exactly).
#[inline]
fn triangle_area(v0: [f64; 3], v1: [f64; 3], v2: [f64; 3]) -> f64 {
    let e0x = v1[0] - v0[0];
    let e0y = v1[1] - v0[1];
    let e0z = v1[2] - v0[2];
    let e1x = v2[0] - v0[0];
    let e1y = v2[1] - v0[1];
    let e1z = v2[2] - v0[2];
    let cx = e0y * e1z - e0z * e1y;
    let cy = e0z * e1x - e0x * e1z;
    let cz = e0x * e1y - e0y * e1x;
    (cx * cx + cy * cy + cz * cz).sqrt() * 0.5
}

#[inline]
fn distance(a: [f64; 3], b: [f64; 3]) -> f64 {
    let dx = a[0] - b[0];
    let dy = a[1] - b[1];
    let dz = a[2] - b[2];
    (dx * dx + dy * dy + dz * dz).sqrt()
}

fn is_backface(r: [f64; 3], t: [f64; 3], min_dot: f64) -> bool {
    let dot = r[0] * t[0] + r[1] * t[1] + r[2] * t[2];
    if min_dot == 0.0 {
        return dot <= 0.0;
    }
    let rl2 = r[0] * r[0] + r[1] * r[1] + r[2] * r[2];
    let tl2 = t[0] * t[0] + t[1] * t[1] + t[2] * t[2];
    if rl2 < 1e-24 || tl2 < 1e-24 {
        return false;
    }
    dot < min_dot * (rl2 * tl2).sqrt()
}

fn vertex_backface(v: [f64; 3], m: &[f64; 16], cam_rel: [f64; 3], min_dot: f64) -> bool {
    let r = transform_normal(v, m); // radial = vertexWorld - planetCenter
    let t = [cam_rel[0] - r[0], cam_rel[1] - r[1], cam_rel[2] - r[2]];
    is_backface(r, t, min_dot)
}

fn triangle_backface(
    v0: [f64; 3],
    v1: [f64; 3],
    v2: [f64; 3],
    m: &[f64; 16],
    cam_rel: [f64; 3],
    min_dot: f64,
) -> bool {
    vertex_backface(v0, m, cam_rel, min_dot)
        && vertex_backface(v1, m, cam_rel, min_dot)
        && vertex_backface(v2, m, cam_rel, min_dot)
}

fn outside_frustum(
    r: [f64; 3],
    bound_radius: f64,
    planes: &[[f64; 4]],
    guard_scale: f64,
) -> bool {
    let margin = bound_radius * (1.0 + guard_scale);
    for pl in planes {
        let d = pl[0] * r[0] + pl[1] * r[1] + pl[2] * r[2] + pl[3];
        if d < -margin {
            return true;
        }
    }
    false
}

pub fn classify_leaves(leaves: &[CbtLeaf], p: &ClassifyParams) -> ClassifyResult {
    let split_threshold = p.split_threshold_px2 * p.split_hysteresis.clamp(0.05, 1.0);
    let merge_threshold = p.split_threshold_px2 * p.split_hysteresis;
    let focal2 = p.focal * p.focal;

    let cam_rel = [
        p.camera_world[0] - p.planet_center_world[0],
        p.camera_world[1] - p.planet_center_world[1],
        p.camera_world[2] - p.planet_center_world[2],
    ];

    // (id, score) in iteration order; stable-sorted later (matches JS stable sort).
    let mut candidates: Vec<(usize, f64)> = Vec::new();
    // insertion-ordered parent aggregation (children count, max area).
    let mut parent_order: Vec<usize> = Vec::new();
    let mut parent_children: std::collections::HashMap<usize, (u32, f64)> =
        std::collections::HashMap::new();

    let inv3 = 1.0 / 3.0;

    for leaf in leaves {
        let cx = (leaf.v0[0] + leaf.v1[0] + leaf.v2[0]) * inv3;
        let cy = (leaf.v0[1] + leaf.v1[1] + leaf.v2[1]) * inv3;
        let cz = (leaf.v0[2] + leaf.v1[2] + leaf.v2[2]) * inv3;
        let centroid_local = [cx, cy, cz];

        let rotated = transform_normal(centroid_local, &p.render_mat);
        let centroid_world = [
            p.planet_center_world[0] + rotated[0],
            p.planet_center_world[1] + rotated[1],
            p.planet_center_world[2] + rotated[2],
        ];

        let dist = MIN_DISTANCE.max(distance(p.camera_world, centroid_world));
        let area_world = triangle_area(leaf.v0, leaf.v1, leaf.v2);
        let projected_area_px2 = area_world * focal2 / (dist * dist);

        if projected_area_px2 >= split_threshold {
            let mut culled = p.cull_backface
                && triangle_backface(
                    leaf.v0,
                    leaf.v1,
                    leaf.v2,
                    &p.render_mat,
                    cam_rel,
                    p.cull_min_dot,
                );

            if !culled {
                if let Some(planes) = p.frustum_planes {
                    let mut br2 = 0.0;
                    for v in [leaf.v0, leaf.v1, leaf.v2] {
                        let dx = v[0] - cx;
                        let dy = v[1] - cy;
                        let dz = v[2] - cz;
                        let d2 = dx * dx + dy * dy + dz * dz;
                        if d2 > br2 {
                            br2 = d2;
                        }
                    }
                    let bound_radius = br2.sqrt();
                    let rel = [
                        centroid_world[0] - p.camera_world[0],
                        centroid_world[1] - p.camera_world[1],
                        centroid_world[2] - p.camera_world[2],
                    ];
                    culled = outside_frustum(rel, bound_radius, planes, p.frustum_guard_scale);
                }
            }

            if !culled {
                candidates.push((leaf.id, projected_area_px2));
            }
        }

        if leaf.parent >= 0 {
            let key = leaf.parent as usize;
            match parent_children.get_mut(&key) {
                Some(entry) => {
                    entry.0 += 1;
                    if projected_area_px2 > entry.1 {
                        entry.1 = projected_area_px2;
                    }
                }
                None => {
                    parent_order.push(key);
                    parent_children.insert(key, (1, projected_area_px2));
                }
            }
        }
    }

    // Stable sort desc by score (JS Array.sort is stable since ES2019).
    candidates.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
    let split_candidates: Vec<usize> = candidates.into_iter().map(|(id, _)| id).collect();

    // Filter eligible parents (2 leaf children, below merge threshold), then stable
    // sort asc by max child area — preserving first-seen order for ties.
    let mut merge: Vec<(usize, f64)> = parent_order
        .into_iter()
        .filter_map(|pid| {
            let (children, max_area) = parent_children[&pid];
            if children == 2 && max_area <= merge_threshold {
                Some((pid, max_area))
            } else {
                None
            }
        })
        .collect();
    merge.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
    let merge_parents: Vec<usize> = merge.into_iter().map(|(id, _)| id).collect();

    ClassifyResult {
        split_candidates,
        merge_parents,
    }
}
