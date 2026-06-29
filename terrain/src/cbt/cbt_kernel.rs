//! wasm-bindgen glue exposing one per-planet CBT kernel to the worker. Owns the
//! tree state + emit cache; `update()` runs classify + split/merge + (conditional)
//! emit and returns the geometry typed arrays + stats to JS. The worker transfers
//! the geometry buffers to the main thread. Everything numeric lives in the pure
//! modules (validated bit-for-bit against TS); this file is just marshalling.

use js_sys::{Float32Array, Object, Reflect, Uint16Array, Uint32Array};
use wasm_bindgen::prelude::*;

use crate::cbt::cbt_classify::{classify_leaves, ClassifyParams};
use crate::cbt::cbt_emit::{CbtEmitCache, EmitResult, Indices};
use crate::cbt::cbt_noise::{build_perm, NoiseParams};
use crate::cbt::cbt_state::CbtState;

// Flat camera params layout (Float64Array), shared with cbt_worker_protocol.ts:
//   [0..3]   cameraWorldDouble
//   [3..6]   planetCenterWorldDouble
//   [6..22]  renderParentWorldMatrix (16, Babylon row-major Matrix.m)
//   [22]     focal (= viewportHeightPx / (2*tan(fov/2)), computed on main thread)
//   [23]     reserved
//   [24..48] frustum planes 6*(nx,ny,nz,d) — present only when has_frustum
const OFF_FOCAL: usize = 22;
const OFF_PLANES: usize = 24;
const PARAMS_BASE_LEN: usize = 24;
const PARAMS_WITH_FRUSTUM_LEN: usize = 48;

struct Frame {
    camera: [f64; 3],
    center: [f64; 3],
    mat: [f64; 16],
    focal: f64,
    planes: Vec<[f64; 4]>,
}

#[wasm_bindgen]
pub struct CbtKernel {
    state: CbtState,
    cache: CbtEmitCache,
    perm: [u8; 512],
    noise: NoiseParams,
    radius: f64,
    split_threshold_px2: f64,
    split_hysteresis: f64,
    max_splits: u32,
    max_merges: u32,
    cull_backface: bool,
    cull_min_dot: f64,
    frustum_guard_scale: f64,
    pending_full_refresh: bool,
}

#[wasm_bindgen]
impl CbtKernel {
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        radius_sim: f64,
        max_depth: u32,
        split_threshold_px2: f64,
        split_hysteresis: f64,
        max_splits: u32,
        max_merges: u32,
        cull_backface: bool,
        cull_min_dot: f64,
        frustum_guard_scale: f64,
        seed: i32,
        octaves: u32,
        base_frequency: f64,
        base_amplitude: f64,
        lacunarity: f64,
        persistence: f64,
        global_amplitude: f64,
    ) -> CbtKernel {
        let noise = NoiseParams {
            seed,
            octaves,
            base_frequency,
            base_amplitude,
            lacunarity,
            persistence,
            global_amplitude,
        };
        CbtKernel {
            state: CbtState::new(radius_sim, max_depth),
            cache: CbtEmitCache::new(),
            perm: build_perm(seed),
            noise,
            radius: radius_sim,
            split_threshold_px2,
            split_hysteresis,
            max_splits,
            max_merges,
            cull_backface,
            cull_min_dot,
            frustum_guard_scale,
            pending_full_refresh: true,
        }
    }

    /// Run one classify + split + merge + (conditional) emit cycle. Returns a JS
    /// object: { geometryChanged, leafCount, splitsThisFrame, mergesThisFrame,
    /// lastVertexCount, geometry? }. `geometry` (6 typed arrays) is present only
    /// when the topology changed; the worker transfers its buffers.
    pub fn update(&mut self, params: &[f64], has_frustum: bool) -> Result<JsValue, JsValue> {
        let frame = parse_frame(params, has_frustum)?;
        let (split_count, merge_count) = self.step(&frame, has_frustum);

        let changed = split_count > 0 || merge_count > 0 || self.pending_full_refresh;
        let out = Object::new();
        set_num(&out, "leafCount", self.state.leaf_count() as f64)?;
        set_num(&out, "splitsThisFrame", split_count as f64)?;
        set_num(&out, "mergesThisFrame", merge_count as f64)?;
        Reflect::set(&out, &"geometryChanged".into(), &JsValue::from_bool(changed))?;

        if changed {
            self.pending_full_refresh = false;
            let leaves = self.state.get_leaf_nodes();
            let geom = self
                .cache
                .emit(&leaves, self.radius, Some((&self.perm, &self.noise)));
            set_num(&out, "lastVertexCount", geom.vertex_count() as f64)?;
            Reflect::set(&out, &"geometry".into(), &build_geometry(&geom)?)?;
        } else {
            set_num(&out, "lastVertexCount", 0.0)?;
        }
        Ok(out.into())
    }

    /// Defer a full re-emit to the next update (mirrors CbtPlanet.resetNow).
    pub fn reset_now(&mut self) {
        self.pending_full_refresh = true;
    }

    /// Worker-side prewarm: refine toward the given camera up to `max_iters`,
    /// stopping early once a pass produces no split/merge. Non-blocking for the
    /// main thread (runs in the worker before the first geometry_result).
    pub fn prewarm(&mut self, params: &[f64], has_frustum: bool, max_iters: u32) -> Result<(), JsValue> {
        let frame = parse_frame(params, has_frustum)?;
        for _ in 0..max_iters {
            let (s, m) = self.step(&frame, has_frustum);
            if s == 0 && m == 0 {
                break;
            }
        }
        Ok(())
    }

    fn step(&mut self, frame: &Frame, has_frustum: bool) -> (u32, u32) {
        let leaves = self.state.get_leaf_nodes();
        let cp = ClassifyParams {
            camera_world: frame.camera,
            planet_center_world: frame.center,
            render_mat: frame.mat,
            focal: frame.focal,
            split_threshold_px2: self.split_threshold_px2,
            split_hysteresis: self.split_hysteresis,
            cull_backface: self.cull_backface,
            cull_min_dot: self.cull_min_dot,
            frustum_planes: if has_frustum {
                Some(&frame.planes)
            } else {
                None
            },
            frustum_guard_scale: self.frustum_guard_scale,
        };
        let res = classify_leaves(&leaves, &cp);
        let s = self.state.split_by_priority(&res.split_candidates, self.max_splits);
        let m = self
            .state
            .merge_by_parent_priority(&res.merge_parents, self.max_merges);
        (s, m)
    }
}

fn parse_frame(params: &[f64], has_frustum: bool) -> Result<Frame, JsValue> {
    let need = if has_frustum {
        PARAMS_WITH_FRUSTUM_LEN
    } else {
        PARAMS_BASE_LEN
    };
    if params.len() < need {
        return Err(JsValue::from_str(&format!(
            "cbt update params too short: {} < {need}",
            params.len()
        )));
    }
    let camera = [params[0], params[1], params[2]];
    let center = [params[3], params[4], params[5]];
    let mut mat = [0.0f64; 16];
    mat.copy_from_slice(&params[6..22]);
    let focal = params[OFF_FOCAL];
    let mut planes = Vec::new();
    if has_frustum {
        for i in 0..6 {
            let o = OFF_PLANES + i * 4;
            planes.push([params[o], params[o + 1], params[o + 2], params[o + 3]]);
        }
    }
    Ok(Frame {
        camera,
        center,
        mat,
        focal,
        planes,
    })
}

fn set_num(o: &Object, key: &str, v: f64) -> Result<(), JsValue> {
    Reflect::set(o, &key.into(), &JsValue::from_f64(v))?;
    Ok(())
}

fn build_geometry(geom: &EmitResult) -> Result<JsValue, JsValue> {
    let o = Object::new();
    set_f32(&o, "positions", &geom.positions)?;
    set_f32(&o, "normals", &geom.normals)?;
    set_f32(&o, "uvs", &geom.uvs)?;
    set_f32(&o, "colors", &geom.colors)?;
    set_f32(&o, "morphDeltas", &geom.morph_deltas)?;
    match &geom.indices {
        Indices::U16(v) => {
            let a = Uint16Array::new_with_length(v.len() as u32);
            a.copy_from(v);
            Reflect::set(&o, &"indices".into(), &a)?;
        }
        Indices::U32(v) => {
            let a = Uint32Array::new_with_length(v.len() as u32);
            a.copy_from(v);
            Reflect::set(&o, &"indices".into(), &a)?;
        }
    }
    Ok(o.into())
}

fn set_f32(o: &Object, key: &str, data: &[f32]) -> Result<(), JsValue> {
    let a = Float32Array::new_with_length(data.len() as u32);
    a.copy_from(data);
    Reflect::set(o, &key.into(), &a)?;
    Ok(())
}
