//! Bit-exact Rust port of CBT mesh emission (src/systems/lod/cbt/cbt_emit.ts):
//! per-leaf 3 vertices (normalize -> radial FBM displacement -> finite-difference
//! normal -> spherical UV -> LOD colour), plus outward-winding index selection and
//! the incremental per-slot cache.
//!
//! Positions/normals/colors use only `+`/`*`/`sqrt`/FBM (no transcendentals) so they
//! match TS bit-for-bit after the `f64 as f32` store (round-to-nearest-even, same as
//! a Float32Array store). UVs use atan2/asin and may differ by an ULP — they are
//! cosmetic (the per-pixel-normal shader ignores the emitted UV/normal) and feed
//! back into nothing, so the topology stays bit-exact.

use crate::cbt::cbt_noise::{build_perm, fbm_noise, NoiseParams};
use crate::cbt::cbt_state::CbtLeaf;

const GRAD_EPS: f64 = 5e-3;
const PI: f64 = std::f64::consts::PI;

/// LOD level colour palette (up to 16 levels) — matches LEVEL_COLORS in cbt_emit.ts.
const LEVEL_COLORS: [[f64; 3]; 16] = [
    [0.15, 0.15, 0.80],
    [0.10, 0.50, 0.90],
    [0.10, 0.75, 0.75],
    [0.10, 0.80, 0.30],
    [0.50, 0.85, 0.10],
    [0.90, 0.90, 0.10],
    [1.00, 0.65, 0.05],
    [1.00, 0.35, 0.05],
    [0.90, 0.10, 0.10],
    [0.80, 0.10, 0.50],
    [0.60, 0.10, 0.70],
    [0.40, 0.10, 0.80],
    [1.00, 1.00, 1.00],
    [0.70, 0.70, 0.70],
    [0.40, 0.40, 0.40],
    [1.00, 0.00, 1.00],
];

/// Prebuilt noise context (perm table + params). None disables displacement.
pub type NoiseCtx<'a> = Option<(&'a [u8; 512], &'a NoiseParams)>;

pub enum Indices {
    U16(Vec<u16>),
    U32(Vec<u32>),
}

pub struct EmitResult {
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub uvs: Vec<f32>,
    pub colors: Vec<f32>,
    pub morph_deltas: Vec<f32>,
    pub indices: Indices,
}

impl EmitResult {
    pub fn vertex_count(&self) -> usize {
        self.positions.len() / 3
    }
}

/// Convenience: build the perm table for a NoiseParams (the TS side caches by seed).
pub fn perm_for(params: &NoiseParams) -> [u8; 512] {
    build_perm(params.seed)
}

#[inline]
fn spherical_uv(nx: f64, ny: f64, nz: f64) -> (f64, f64) {
    let u = 0.5 + nz.atan2(nx) / (2.0 * PI);
    let v = 0.5 - ny.min(1.0).max(-1.0).asin() / PI;
    (u, v)
}

fn sphere_tangents(nx: f64, ny: f64, nz: f64) -> ([f64; 3], [f64; 3]) {
    let (mut ax, mut ay, mut az) = (0.0, 1.0, 0.0);
    if ny.abs() > 0.9 {
        ax = 1.0;
        ay = 0.0;
        az = 0.0;
    }
    let mut tx = ny * az - nz * ay;
    let mut ty = nz * ax - nx * az;
    let mut tz = nx * ay - ny * ax;
    let t_len = (tx * tx + ty * ty + tz * tz).sqrt();
    let t_inv = if t_len > 1e-12 { 1.0 / t_len } else { 0.0 };
    tx *= t_inv;
    ty *= t_inv;
    tz *= t_inv;
    let bx = ny * tz - nz * ty;
    let by = nz * tx - nx * tz;
    let bz = nx * ty - ny * tx;
    ([tx, ty, tz], [bx, by, bz])
}

fn noise_normal(
    perm: &[u8; 512],
    params: &NoiseParams,
    nx: f64,
    ny: f64,
    nz: f64,
    radius: f64,
) -> [f64; 3] {
    let (t, b) = sphere_tangents(nx, ny, nz);
    let eps = GRAD_EPS;

    let sample = |dx: f64, dy: f64, dz: f64| -> f64 {
        let sx = nx + dx;
        let sy = ny + dy;
        let sz = nz + dz;
        let len = (sx * sx + sy * sy + sz * sz).sqrt();
        let inv = if len > 1e-12 { 1.0 / len } else { 0.0 };
        fbm_noise(perm, sx * inv, sy * inv, sz * inv, params)
    };

    let dhdt = (sample(t[0] * eps, t[1] * eps, t[2] * eps)
        - sample(-t[0] * eps, -t[1] * eps, -t[2] * eps))
        / (2.0 * eps);
    let dhdb = (sample(b[0] * eps, b[1] * eps, b[2] * eps)
        - sample(-b[0] * eps, -b[1] * eps, -b[2] * eps))
        / (2.0 * eps);

    let scale = 1.0 / radius;
    let mut pnx = nx - dhdt * scale * t[0] - dhdb * scale * b[0];
    let mut pny = ny - dhdt * scale * t[1] - dhdb * scale * b[1];
    let mut pnz = nz - dhdt * scale * t[2] - dhdb * scale * b[2];

    let len = (pnx * pnx + pny * pny + pnz * pnz).sqrt();
    let inv = if len > 1e-12 { 1.0 / len } else { 0.0 };
    pnx *= inv;
    pny *= inv;
    pnz *= inv;
    [pnx, pny, pnz]
}

#[allow(clippy::too_many_arguments)]
fn compute_leaf_vertex_data(
    v0: [f64; 3],
    v1: [f64; 3],
    v2: [f64; 3],
    level: u8,
    radius: f64,
    noise: NoiseCtx,
    pos: &mut [f32],
    po: usize,
    nrm: &mut [f32],
    no: usize,
    uv: &mut [f32],
    uo: usize,
    col: &mut [f32],
    co: usize,
) {
    let lc = LEVEL_COLORS[(level as usize) % LEVEL_COLORS.len()];
    let verts = [v0, v1, v2];
    for k in 0..3 {
        let vert = verts[k];
        let len = (vert[0] * vert[0] + vert[1] * vert[1] + vert[2] * vert[2]).sqrt();
        let inv_len = if len > 1e-12 { 1.0 / len } else { 0.0 };
        let nx = vert[0] * inv_len;
        let ny = vert[1] * inv_len;
        let nz = vert[2] * inv_len;

        let mut r = radius;
        if let Some((perm, params)) = noise {
            r += fbm_noise(perm, nx, ny, nz, params);
        }
        let p = po + k * 3;
        pos[p] = (nx * r) as f32;
        pos[p + 1] = (ny * r) as f32;
        pos[p + 2] = (nz * r) as f32;

        let n = no + k * 3;
        if let Some((perm, params)) = noise {
            let nn = noise_normal(perm, params, nx, ny, nz, radius);
            nrm[n] = nn[0] as f32;
            nrm[n + 1] = nn[1] as f32;
            nrm[n + 2] = nn[2] as f32;
        } else {
            nrm[n] = nx as f32;
            nrm[n + 1] = ny as f32;
            nrm[n + 2] = nz as f32;
        }

        let (u, v) = spherical_uv(nx, ny, nz);
        let uoff = uo + k * 2;
        uv[uoff] = u as f32;
        uv[uoff + 1] = v as f32;

        let coff = co + k * 4;
        col[coff] = lc[0] as f32;
        col[coff + 1] = lc[1] as f32;
        col[coff + 2] = lc[2] as f32;
        col[coff + 3] = 1.0;
    }
}

/// Outward-facing winding for triangle `tri`, reading positions back (as f32->f64,
/// matching the TS Float32Array readback). Returns the 3 index values in order.
fn triangle_winding(positions: &[f32], tri: usize) -> [usize; 3] {
    let base = tri * 3;
    let b0 = base * 3;
    let b1 = b0 + 3;
    let b2 = b0 + 6;
    let ax = positions[b0] as f64;
    let ay = positions[b0 + 1] as f64;
    let az = positions[b0 + 2] as f64;
    let bx = positions[b1] as f64;
    let by = positions[b1 + 1] as f64;
    let bz = positions[b1 + 2] as f64;
    let cx = positions[b2] as f64;
    let cy = positions[b2 + 1] as f64;
    let cz = positions[b2 + 2] as f64;
    let e1x = bx - ax;
    let e1y = by - ay;
    let e1z = bz - az;
    let e2x = cx - ax;
    let e2y = cy - ay;
    let e2z = cz - az;
    let nrx = e1y * e2z - e1z * e2y;
    let nry = e1z * e2x - e1x * e2z;
    let nrz = e1x * e2y - e1y * e2x;
    let outward = nrx * (ax + bx + cx) + nry * (ay + by + cy) + nrz * (az + bz + cz) > 0.0;
    if outward {
        [base, base + 2, base + 1]
    } else {
        [base, base + 1, base + 2]
    }
}

fn make_indices(tv: usize) -> Indices {
    if tv > 65535 {
        Indices::U32(vec![0u32; tv])
    } else {
        Indices::U16(vec![0u16; tv])
    }
}

fn store_winding(indices: &mut Indices, tri: usize, w: [usize; 3]) {
    let base = tri * 3;
    match indices {
        Indices::U16(v) => {
            v[base] = w[0] as u16;
            v[base + 1] = w[1] as u16;
            v[base + 2] = w[2] as u16;
        }
        Indices::U32(v) => {
            v[base] = w[0] as u32;
            v[base + 1] = w[1] as u32;
            v[base + 2] = w[2] as u32;
        }
    }
}

/// Full emitter — one mesh from all leaf triangles (3 verts each). Mirrors
/// `emitMeshFromLeaves`.
pub fn emit_mesh_from_leaves(leaves: &[CbtLeaf], radius: f64, noise: NoiseCtx) -> EmitResult {
    let tv = leaves.len() * 3;
    let mut positions = vec![0f32; tv * 3];
    let mut normals = vec![0f32; tv * 3];
    let morph_deltas = vec![0f32; tv * 3];
    let mut uvs = vec![0f32; tv * 2];
    let mut colors = vec![0f32; tv * 4];
    let mut indices = make_indices(tv);

    for (i, leaf) in leaves.iter().enumerate() {
        compute_leaf_vertex_data(
            leaf.v0,
            leaf.v1,
            leaf.v2,
            leaf.level,
            radius,
            noise,
            &mut positions,
            i * 9,
            &mut normals,
            i * 9,
            &mut uvs,
            i * 6,
            &mut colors,
            i * 12,
        );
        let w = triangle_winding(&positions, i);
        store_winding(&mut indices, i, w);
    }

    EmitResult {
        positions,
        normals,
        uvs,
        colors,
        morph_deltas,
        indices,
    }
}

/// Incremental emitter — caches per-slot vertex data keyed by stable slot id, so on
/// a topology change only the changed slots recompute noise. Output is byte-identical
/// to `emit_mesh_from_leaves`. Mirrors `CbtEmitCache`.
pub struct CbtEmitCache {
    cap: usize,
    pos: Vec<f32>,  // cap*9
    nrm: Vec<f32>,  // cap*9
    uv: Vec<f32>,   // cap*6
    col: Vec<f32>,  // cap*12
    geom: Vec<f64>, // cap*9 — cached (v0,v1,v2) to detect slot reuse
    valid: Vec<u8>, // cap
    pub recomputed: usize,
}

impl Default for CbtEmitCache {
    fn default() -> Self {
        Self::new()
    }
}

impl CbtEmitCache {
    pub fn new() -> Self {
        CbtEmitCache {
            cap: 0,
            pos: Vec::new(),
            nrm: Vec::new(),
            uv: Vec::new(),
            col: Vec::new(),
            geom: Vec::new(),
            valid: Vec::new(),
            recomputed: 0,
        }
    }

    fn ensure_cap(&mut self, n: usize) {
        if n <= self.cap {
            return;
        }
        let mut nc = if self.cap == 0 { 256 } else { self.cap };
        while nc < n {
            nc *= 2;
        }
        self.pos.resize(nc * 9, 0.0);
        self.nrm.resize(nc * 9, 0.0);
        self.uv.resize(nc * 6, 0.0);
        self.col.resize(nc * 12, 0.0);
        self.geom.resize(nc * 9, 0.0);
        self.valid.resize(nc, 0);
        self.cap = nc;
    }

    fn sync_leaf(&mut self, leaf: &CbtLeaf, radius: f64, noise: NoiseCtx) {
        let slot = leaf.id;
        let g = slot * 9;
        let (v0, v1, v2) = (leaf.v0, leaf.v1, leaf.v2);
        if self.valid[slot] == 1
            && self.geom[g] == v0[0]
            && self.geom[g + 1] == v0[1]
            && self.geom[g + 2] == v0[2]
            && self.geom[g + 3] == v1[0]
            && self.geom[g + 4] == v1[1]
            && self.geom[g + 5] == v1[2]
            && self.geom[g + 6] == v2[0]
            && self.geom[g + 7] == v2[1]
            && self.geom[g + 8] == v2[2]
        {
            return; // cache hit — geometry unchanged
        }
        compute_leaf_vertex_data(
            v0,
            v1,
            v2,
            leaf.level,
            radius,
            noise,
            &mut self.pos,
            slot * 9,
            &mut self.nrm,
            slot * 9,
            &mut self.uv,
            slot * 6,
            &mut self.col,
            slot * 12,
        );
        self.geom[g] = v0[0];
        self.geom[g + 1] = v0[1];
        self.geom[g + 2] = v0[2];
        self.geom[g + 3] = v1[0];
        self.geom[g + 4] = v1[1];
        self.geom[g + 5] = v1[2];
        self.geom[g + 6] = v2[0];
        self.geom[g + 7] = v2[1];
        self.geom[g + 8] = v2[2];
        self.valid[slot] = 1;
        self.recomputed += 1;
    }

    pub fn emit(&mut self, leaves: &[CbtLeaf], radius: f64, noise: NoiseCtx) -> EmitResult {
        let mut max_slot = 0;
        for leaf in leaves {
            if leaf.id > max_slot {
                max_slot = leaf.id;
            }
        }
        self.ensure_cap(max_slot + 1);

        self.recomputed = 0;
        for leaf in leaves {
            self.sync_leaf(leaf, radius, noise);
        }

        let tv = leaves.len() * 3;
        let mut positions = vec![0f32; tv * 3];
        let mut normals = vec![0f32; tv * 3];
        let morph_deltas = vec![0f32; tv * 3];
        let mut uvs = vec![0f32; tv * 2];
        let mut colors = vec![0f32; tv * 4];
        let mut indices = make_indices(tv);

        for (i, leaf) in leaves.iter().enumerate() {
            let slot = leaf.id;
            positions[i * 9..i * 9 + 9].copy_from_slice(&self.pos[slot * 9..slot * 9 + 9]);
            normals[i * 9..i * 9 + 9].copy_from_slice(&self.nrm[slot * 9..slot * 9 + 9]);
            uvs[i * 6..i * 6 + 6].copy_from_slice(&self.uv[slot * 6..slot * 6 + 6]);
            colors[i * 12..i * 12 + 12].copy_from_slice(&self.col[slot * 12..slot * 12 + 12]);
            let w = triangle_winding(&positions, i);
            store_winding(&mut indices, i, w);
        }

        EmitResult {
            positions,
            normals,
            uvs,
            colors,
            morph_deltas,
            indices,
        }
    }
}
