//! Validates the Rust CBT pipeline (state + classify + emit) end-to-end against a
//! fixture dumped from the REAL TypeScript pipeline
//! (src/systems/lod/cbt/cbt_scenario_fixture.gen.test.ts). Replays the identical
//! frame sequence (refine then recede, with backside + frustum culls) and asserts:
//!   - final topology (leaf id/level/parent + the 3 vertices) bit-for-bit,
//!   - positions / normals / colors / indices bit-for-bit,
//!   - UVs within an ULP tolerance (atan2/asin are the only cosmetic divergence),
//!   - the incremental cache emit equals the full emit,
//!   - the final mesh is watertight + restricted (conformity).

use super::cbt_classify::{classify_leaves, ClassifyParams};
use super::cbt_emit::{emit_mesh_from_leaves, CbtEmitCache, Indices};
use super::cbt_noise::NoiseParams;
use super::cbt_state::CbtState;

const FIXTURE: &str = include_str!("../../tests/cbt_scenario_fixture.txt");

fn hx(h: &str) -> f64 {
    f64::from_bits(u64::from_str_radix(h, 16).expect("hex bits"))
}

struct Leaf {
    id: usize,
    level: u8,
    parent: i32,
    v: [f64; 9],
}

#[test]
fn matches_typescript_scenario_bit_for_bit() {
    // ---- parse the fixture ----
    let mut radius = 0.0;
    let mut max_depth = 0u32;
    let mut noise = NoiseParams {
        seed: 0,
        octaves: 0,
        base_frequency: 0.0,
        base_amplitude: 0.0,
        lacunarity: 0.0,
        persistence: 0.0,
        global_amplitude: 0.0,
    };
    let mut planet_center = [0.0; 3];

    let mut split_threshold_px2 = 0.0;
    let mut split_hysteresis = 0.0;
    let mut cull_backface = false;
    let mut cull_min_dot = 0.0;
    let mut frustum_guard_scale = 0.0;
    let mut max_splits = 0u32;
    let mut max_merges = 0u32;
    let mut iters = 0usize;
    let mut has_frustum = false;
    let mut focal = 0.0;

    let mut render_mat = [0.0f64; 16];
    let mut planes: Vec<[f64; 4]> = Vec::new();
    let mut frames: Vec<[f64; 3]> = Vec::new();
    let mut exp_leaves: Vec<Leaf> = Vec::new();
    let mut exp_pos: Vec<f64> = Vec::new();
    let mut exp_nrm: Vec<f64> = Vec::new();
    let mut exp_uv: Vec<f64> = Vec::new();
    let mut exp_col: Vec<f64> = Vec::new();
    let mut exp_idx: Vec<usize> = Vec::new();

    for line in FIXTURE.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut it = line.split_whitespace();
        match it.next().unwrap() {
            "C" => {
                radius = hx(it.next().unwrap());
                max_depth = it.next().unwrap().parse().unwrap();
                noise.seed = it.next().unwrap().parse().unwrap();
                noise.octaves = it.next().unwrap().parse().unwrap();
                noise.base_frequency = hx(it.next().unwrap());
                noise.base_amplitude = hx(it.next().unwrap());
                noise.lacunarity = hx(it.next().unwrap());
                noise.persistence = hx(it.next().unwrap());
                noise.global_amplitude = hx(it.next().unwrap());
                planet_center[0] = hx(it.next().unwrap());
                planet_center[1] = hx(it.next().unwrap());
                planet_center[2] = hx(it.next().unwrap());
            }
            "F" => {
                split_threshold_px2 = hx(it.next().unwrap());
                split_hysteresis = hx(it.next().unwrap());
                cull_backface = it.next().unwrap() == "1";
                cull_min_dot = hx(it.next().unwrap());
                frustum_guard_scale = hx(it.next().unwrap());
                max_splits = it.next().unwrap().parse().unwrap();
                max_merges = it.next().unwrap().parse().unwrap();
                iters = it.next().unwrap().parse().unwrap();
                has_frustum = it.next().unwrap() == "1";
                focal = hx(it.next().unwrap());
            }
            "MAT" => {
                for slot in render_mat.iter_mut() {
                    *slot = hx(it.next().unwrap());
                }
            }
            "PL" => {
                planes.push([
                    hx(it.next().unwrap()),
                    hx(it.next().unwrap()),
                    hx(it.next().unwrap()),
                    hx(it.next().unwrap()),
                ]);
            }
            "FRAME" => {
                frames.push([
                    hx(it.next().unwrap()),
                    hx(it.next().unwrap()),
                    hx(it.next().unwrap()),
                ]);
            }
            "LEAF" => {
                let id: usize = it.next().unwrap().parse().unwrap();
                let level: u8 = it.next().unwrap().parse().unwrap();
                let parent: i32 = it.next().unwrap().parse().unwrap();
                let mut v = [0.0f64; 9];
                for slot in v.iter_mut() {
                    *slot = hx(it.next().unwrap());
                }
                exp_leaves.push(Leaf {
                    id,
                    level,
                    parent,
                    v,
                });
            }
            "POS" => exp_pos.extend(it.map(hx)),
            "NRM" => exp_nrm.extend(it.map(hx)),
            "UVS" => exp_uv.extend(it.map(hx)),
            "COL" => exp_col.extend(it.map(hx)),
            "IDX" => {
                let _fmt = it.next().unwrap();
                exp_idx.extend(it.map(|t| t.parse::<usize>().unwrap()));
            }
            other => panic!("unknown fixture kind {other}"),
        }
    }

    assert_eq!(frames.len(), iters, "frame count");
    let perm = super::cbt_emit::perm_for(&noise);

    // ---- replay (mirrors LocalCbtSource.requestUpdate) ----
    let mut state = CbtState::new(radius, max_depth);
    for frame in frames.iter().take(iters) {
        let leaves = state.get_leaf_nodes();
        let params = ClassifyParams {
            camera_world: *frame,
            planet_center_world: planet_center,
            render_mat,
            focal,
            split_threshold_px2,
            split_hysteresis,
            cull_backface,
            cull_min_dot,
            frustum_planes: if has_frustum { Some(&planes) } else { None },
            frustum_guard_scale,
        };
        let res = classify_leaves(&leaves, &params);
        state.split_by_priority(&res.split_candidates, max_splits);
        state.merge_by_parent_priority(&res.merge_parents, max_merges);
    }

    // ---- topology bit-for-bit ----
    let leaves = state.get_leaf_nodes();
    assert_eq!(leaves.len(), exp_leaves.len(), "final leaf count");
    for (i, (got, exp)) in leaves.iter().zip(exp_leaves.iter()).enumerate() {
        assert_eq!(got.id, exp.id, "leaf[{i}].id");
        assert_eq!(got.level, exp.level, "leaf[{i}].level");
        assert_eq!(got.parent, exp.parent, "leaf[{i}].parent");
        let g = [
            got.v0[0], got.v0[1], got.v0[2], got.v1[0], got.v1[1], got.v1[2], got.v2[0],
            got.v2[1], got.v2[2],
        ];
        for k in 0..9 {
            assert_eq!(
                g[k].to_bits(),
                exp.v[k].to_bits(),
                "leaf[{i}] vert[{k}]: {} vs {}",
                g[k],
                exp.v[k]
            );
        }
    }

    // ---- geometry ----
    let geom = emit_mesh_from_leaves(&leaves, radius, Some((&perm, &noise)));

    assert_eq!(geom.positions.len(), exp_pos.len(), "positions len");
    for (i, (g, e)) in geom.positions.iter().zip(exp_pos.iter()).enumerate() {
        assert_eq!((*g as f64).to_bits(), e.to_bits(), "positions[{i}] {g} vs {e}");
    }
    assert_eq!(geom.normals.len(), exp_nrm.len(), "normals len");
    for (i, (g, e)) in geom.normals.iter().zip(exp_nrm.iter()).enumerate() {
        assert_eq!((*g as f64).to_bits(), e.to_bits(), "normals[{i}] {g} vs {e}");
    }
    assert_eq!(geom.colors.len(), exp_col.len(), "colors len");
    for (i, (g, e)) in geom.colors.iter().zip(exp_col.iter()).enumerate() {
        assert_eq!((*g as f64).to_bits(), e.to_bits(), "colors[{i}] {g} vs {e}");
    }
    // UVs: atan2/asin may differ by an ULP — cosmetic, fed back into nothing.
    assert_eq!(geom.uvs.len(), exp_uv.len(), "uvs len");
    let mut max_uv_err = 0.0f64;
    for (g, e) in geom.uvs.iter().zip(exp_uv.iter()) {
        max_uv_err = max_uv_err.max((*g as f64 - *e).abs());
    }
    assert!(max_uv_err < 1e-4, "max UV error {max_uv_err} exceeds tolerance");

    // indices exact
    let got_idx: Vec<usize> = match &geom.indices {
        Indices::U16(v) => v.iter().map(|&x| x as usize).collect(),
        Indices::U32(v) => v.iter().map(|&x| x as usize).collect(),
    };
    assert_eq!(got_idx, exp_idx, "indices");

    // ---- incremental cache equals full emit ----
    let mut cache = CbtEmitCache::new();
    let cached = cache.emit(&leaves, radius, Some((&perm, &noise)));
    assert_eq!(cached.positions, geom.positions, "cache positions == full");
    assert_eq!(cached.normals, geom.normals, "cache normals == full");
    assert_eq!(cached.uvs, geom.uvs, "cache uvs == full");
    assert_eq!(cached.colors, geom.colors, "cache colors == full");
    let cached_idx: Vec<usize> = match &cached.indices {
        Indices::U16(v) => v.iter().map(|&x| x as usize).collect(),
        Indices::U32(v) => v.iter().map(|&x| x as usize).collect(),
    };
    assert_eq!(cached_idx, got_idx, "cache indices == full");

    // ---- watertight + restricted ----
    state.assert_conformity();

    eprintln!(
        "scenario ok: {} leaves, {} verts, max UV err {max_uv_err:.2e}",
        leaves.len(),
        geom.vertex_count()
    );
}
