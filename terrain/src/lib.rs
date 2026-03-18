use js_sys::{Array, Float32Array, Object, Reflect, Uint16Array, Uint32Array};
use noise::{NoiseFn, OpenSimplex};
use wasm_bindgen::prelude::*;

const PI: f64 = core::f64::consts::PI;

// fn saturate(x: f64) -> f64 {
//     if x < 0.0 {
//         0.0
//     } else if x > 1.0 {
//         1.0
//     } else {
//         x
//     }
// }

// fn smoothstep(t: f64) -> f64 {
//     // 3t^2 - 2t^3
//     t * t * (3.0 - 2.0 * t)
// }

fn map_uv_to_cube(u: f64, v: f64, face: &str) -> [f64; 3] {
    match face {
        "front" => [u, v, 1.0],
        "back" => [-u, v, -1.0],
        "left" => [-1.0, v, u],
        "right" => [1.0, v, -u],
        "top" => [u, 1.0, -v],
        "bottom" => [u, -1.0, v],
        _ => [u, v, 1.0],
    }
}

fn length3(a: [f64; 3]) -> f64 {
    (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt()
}

fn normalize3(a: [f64; 3]) -> [f64; 3] {
    let l = length3(a);
    if l <= 1e-12 {
        return [0.0, 0.0, 0.0];
    }
    [a[0] / l, a[1] / l, a[2] / l]
}

fn sub3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn add3(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn scale3(a: [f64; 3], s: f64) -> [f64; 3] {
    [a[0] * s, a[1] * s, a[2] * s]
}

fn lerp3(a: [f64; 3], b: [f64; 3], t: f64) -> [f64; 3] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

fn cross(a: [f64; 3], b: [f64; 3]) -> [f64; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

fn tri_normal(v0: [f64; 3], v1: [f64; 3], v2: [f64; 3]) -> [f64; 3] {
    // JS: edge1 = v1 - v0, edge2 = v2 - v0, normal = edge2.cross(edge1)
    let e1 = sub3(v1, v0);
    let e2 = sub3(v2, v0);
    normalize3(cross(e2, e1))
}

fn fractal_noise(
    simplex: &OpenSimplex,
    x: f64,
    y: f64,
    z: f64,
    octaves: u32,
    base_frequency: f64,
    base_amplitude: f64,
    lacunarity: f64,
    persistence: f64,
) -> f64 {
    let mut sum = 0.0;
    let mut max_possible = 0.0;
    let mut freq = base_frequency;
    let mut amp = base_amplitude;

    for _ in 0..octaves {
        let v = simplex.get([x * freq, y * freq, z * freq]); // [-1..1]
        sum += v * amp;
        max_possible += amp;
        freq *= lacunarity;
        amp *= persistence;
    }

    if max_possible <= 1e-12 {
        0.0
    } else {
        sum / max_possible
    }
}

#[wasm_bindgen]
pub fn build_chunk(
    u_min: f64,
    u_max: f64,
    v_min: f64,
    v_max: f64,
    resolution: u32,
    radius: f64,
    face: String,
    //level: u32,
    seed: i32,
    octaves: u32,
    base_frequency: f64,
    base_amplitude: f64,
    lacunarity: f64,
    persistence: f64,
    global_amp: f64,
) -> Result<JsValue, JsValue> {
    console_error_panic_hook::set_once();

    let res = resolution as usize;
    let vert_count = (res + 1) * (res + 1);
    let index_count = res * res * 6;

    let simplex = OpenSimplex::new(seed as u32);

    // angles (bounds en tan-space)
    let a_u_min = u_min.atan();
    let a_u_max = u_max.atan();
    let a_v_min = v_min.atan();
    let a_v_max = v_max.atan();

    // patch center local (base sphere)
    let a_u_center = 0.5 * (a_u_min + a_u_max);
    let a_v_center = 0.5 * (a_v_min + a_v_max);
    let u_center = a_u_center.tan();
    let v_center = a_v_center.tan();

    let center_cube = map_uv_to_cube(u_center, v_center, &face);
    let center_local = scale3(normalize3(center_cube), radius);
    let dir = normalize3(center_local);

    let mut positions_f = vec![0f32; vert_count * 3];
    let mut normals_f = vec![0f32; vert_count * 3];
    let mut morph_deltas_f = vec![0f32; vert_count * 3];
    let mut uvs_f = vec![0f32; vert_count * 2];
    let mut verts = vec![[0.0f64; 3]; vert_count];

    let mut min_pr = f64::INFINITY;
    let mut max_pr = -f64::INFINITY;

    // PASS 1: vertices
    for i in 0..=res {
        let t_v = (i as f64) / (res as f64);
        let angle_v = a_v_min + (a_v_max - a_v_min) * t_v;
        let v = angle_v.tan();

        for j in 0..=res {
            let t_u = (j as f64) / (res as f64);
            let angle_u = a_u_min + (a_u_max - a_u_min) * t_u;
            let u = angle_u.tan();

            let cube = map_uv_to_cube(u, v, &face);
            let unit = normalize3(cube);

            let f = fractal_noise(
                &simplex,
                unit[0],
                unit[1],
                unit[2],
                octaves,
                base_frequency,
                base_amplitude,
                lacunarity,
                persistence,
            );

            let elevation = f * global_amp;
            let pr = radius + elevation;

            if pr < min_pr {
                min_pr = pr;
            }
            if pr > max_pr {
                max_pr = pr;
            }

            let pos = scale3(unit, pr);
            let idx = i * (res + 1) + j;

            verts[idx] = pos;

            let p_off = idx * 3;
            positions_f[p_off] = pos[0] as f32;
            positions_f[p_off + 1] = pos[1] as f32;
            positions_f[p_off + 2] = pos[2] as f32;

            // radial normal initial
            normals_f[p_off] = (pos[0] / pr) as f32;
            normals_f[p_off + 1] = (pos[1] / pr) as f32;
            normals_f[p_off + 2] = (pos[2] / pr) as f32;

            // spherical UV
            let uu = ((pos[0].atan2(pos[2]) + PI) / (2.0 * PI)) as f32;
            let vv = ((pos[1] / pr).acos() / PI) as f32;

            let uv_off = idx * 2;
            uvs_f[uv_off] = uu;
            uvs_f[uv_off + 1] = vv;
        }
    }

    // Morph target for CDLOD blending: each fine vertex moves toward a coarse grid
    // sample (parent-like geometry reconstructed from the current patch vertices).
    for i in 0..=res {
        for j in 0..=res {
            let idx = i * (res + 1) + j;

            let i0 = (i / 2) * 2;
            let j0 = (j / 2) * 2;
            let i1 = (i0 + 2).min(res);
            let j1 = (j0 + 2).min(res);

            let fx = if j1 == j0 {
                0.0
            } else {
                (j - j0) as f64 / (j1 - j0) as f64
            };
            let fy = if i1 == i0 {
                0.0
            } else {
                (i - i0) as f64 / (i1 - i0) as f64
            };

            let v00 = verts[i0 * (res + 1) + j0];
            let v10 = verts[i0 * (res + 1) + j1];
            let v01 = verts[i1 * (res + 1) + j0];
            let v11 = verts[i1 * (res + 1) + j1];

            let row0 = lerp3(v00, v10, fx);
            let row1 = lerp3(v01, v11, fx);
            let coarse = lerp3(row0, row1, fy);
            let delta = sub3(coarse, verts[idx]);

            let p_off = idx * 3;
            morph_deltas_f[p_off] = delta[0] as f32;
            morph_deltas_f[p_off + 1] = delta[1] as f32;
            morph_deltas_f[p_off + 2] = delta[2] as f32;
        }
    }

    // bounds sphere around centerLocal2
    let center_r = 0.5 * (min_pr + max_pr);
    let center_local2 = scale3(dir, center_r);

    let mut max_d2 = 0.0f64;
    for v in &verts {
        let d = sub3(*v, center_local2);
        let d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        if d2 > max_d2 {
            max_d2 = d2;
        }
    }
    let bounding_radius = max_d2.sqrt();

    // normals averaged
    let mut acc = vec![[0.0f64; 3]; vert_count];
    let mut cnt = vec![0u32; vert_count];

    let use_u16 = vert_count <= 65535;

    if use_u16 {
        let mut indices: Vec<u16> = Vec::with_capacity(index_count);

        for i in 0..res {
            for j in 0..res {
                let index0 = i * (res + 1) + j;
                let index1 = index0 + 1;
                let index2 = (i + 1) * (res + 1) + j;
                let index3 = index2 + 1;

                let v0 = verts[index0];
                let v1 = verts[index1];
                let v2 = verts[index2];
                let v3 = verts[index3];

                let d1 = length3(sub3(v0, v3));
                let d2 = length3(sub3(v1, v2));

                if d1 < d2 {
                    // (0,3,1) + (0,2,3)
                    indices.extend_from_slice(&[
                        index0 as u16,
                        index3 as u16,
                        index1 as u16,
                        index0 as u16,
                        index2 as u16,
                        index3 as u16,
                    ]);

                    let n1 = tri_normal(v0, v3, v1);
                    let n2 = tri_normal(v0, v2, v3);

                    for &k in &[index0, index3, index1] {
                        acc[k] = add3(acc[k], n1);
                        cnt[k] += 1;
                    }
                    for &k in &[index0, index2, index3] {
                        acc[k] = add3(acc[k], n2);
                        cnt[k] += 1;
                    }
                } else {
                    // (0,2,1) + (1,2,3)
                    indices.extend_from_slice(&[
                        index0 as u16,
                        index2 as u16,
                        index1 as u16,
                        index1 as u16,
                        index2 as u16,
                        index3 as u16,
                    ]);

                    let n1 = tri_normal(v0, v2, v1);
                    let n2 = tri_normal(v1, v2, v3);

                    for &k in &[index0, index2, index1] {
                        acc[k] = add3(acc[k], n1);
                        cnt[k] += 1;
                    }
                    for &k in &[index1, index2, index3] {
                        acc[k] = add3(acc[k], n2);
                        cnt[k] += 1;
                    }
                }
            }
        }

        for i in 0..vert_count {
            if cnt[i] > 0 {
                let inv = 1.0 / (cnt[i] as f64);
                let n = normalize3(scale3(acc[i], inv));
                let off = i * 3;
                normals_f[off] = n[0] as f32;
                normals_f[off + 1] = n[1] as f32;
                normals_f[off + 2] = n[2] as f32;
            }
        }

        // Build JS object
        let out = Object::new();

        let pos_js = Float32Array::new_with_length(positions_f.len() as u32);
        pos_js.copy_from(&positions_f);
        Reflect::set(&out, &"positions".into(), &pos_js)?;

        let nor_js = Float32Array::new_with_length(normals_f.len() as u32);
        nor_js.copy_from(&normals_f);
        Reflect::set(&out, &"normals".into(), &nor_js)?;

        let morph_js = Float32Array::new_with_length(morph_deltas_f.len() as u32);
        morph_js.copy_from(&morph_deltas_f);
        Reflect::set(&out, &"morphDeltas".into(), &morph_js)?;

        let uvs_js = Float32Array::new_with_length(uvs_f.len() as u32);
        uvs_js.copy_from(&uvs_f);
        Reflect::set(&out, &"uvs".into(), &uvs_js)?;

        let idx_js = Uint16Array::new_with_length(indices.len() as u32);
        idx_js.copy_from(&indices);
        Reflect::set(&out, &"indices".into(), &idx_js)?;

        let bounds = Object::new();
        let center_arr = Array::new();
        center_arr.push(&JsValue::from_f64(center_local2[0]));
        center_arr.push(&JsValue::from_f64(center_local2[1]));
        center_arr.push(&JsValue::from_f64(center_local2[2]));

        Reflect::set(&bounds, &"centerLocal".into(), &center_arr)?;
        Reflect::set(
            &bounds,
            &"boundingRadius".into(),
            &JsValue::from_f64(bounding_radius),
        )?;
        Reflect::set(
            &bounds,
            &"minPlanetRadius".into(),
            &JsValue::from_f64(min_pr),
        )?;
        Reflect::set(
            &bounds,
            &"maxPlanetRadius".into(),
            &JsValue::from_f64(max_pr),
        )?;
        Reflect::set(&out, &"boundsInfo".into(), &bounds)?;

        Ok(out.into())
    } else {
        let mut indices: Vec<u32> = Vec::with_capacity(index_count);

        for i in 0..res {
            for j in 0..res {
                let index0 = (i * (res + 1) + j) as u32;
                let index1 = index0 + 1;
                let index2 = ((i + 1) * (res + 1) + j) as u32;
                let index3 = index2 + 1;

                let v0 = verts[index0 as usize];
                let v1 = verts[index1 as usize];
                let v2 = verts[index2 as usize];
                let v3 = verts[index3 as usize];

                let d1 = length3(sub3(v0, v3));
                let d2 = length3(sub3(v1, v2));

                if d1 < d2 {
                    indices.extend_from_slice(&[index0, index3, index1, index0, index2, index3]);

                    let n1 = tri_normal(v0, v3, v1);
                    let n2 = tri_normal(v0, v2, v3);

                    for &k in &[index0, index3, index1] {
                        let kk = k as usize;
                        acc[kk] = add3(acc[kk], n1);
                        cnt[kk] += 1;
                    }
                    for &k in &[index0, index2, index3] {
                        let kk = k as usize;
                        acc[kk] = add3(acc[kk], n2);
                        cnt[kk] += 1;
                    }
                } else {
                    indices.extend_from_slice(&[index0, index2, index1, index1, index2, index3]);

                    let n1 = tri_normal(v0, v2, v1);
                    let n2 = tri_normal(v1, v2, v3);

                    for &k in &[index0, index2, index1] {
                        let kk = k as usize;
                        acc[kk] = add3(acc[kk], n1);
                        cnt[kk] += 1;
                    }
                    for &k in &[index1, index2, index3] {
                        let kk = k as usize;
                        acc[kk] = add3(acc[kk], n2);
                        cnt[kk] += 1;
                    }
                }
            }
        }

        for i in 0..vert_count {
            if cnt[i] > 0 {
                let inv = 1.0 / (cnt[i] as f64);
                let n = normalize3(scale3(acc[i], inv));
                let off = i * 3;
                normals_f[off] = n[0] as f32;
                normals_f[off + 1] = n[1] as f32;
                normals_f[off + 2] = n[2] as f32;
            }
        }

        let out = Object::new();

        let pos_js = Float32Array::new_with_length(positions_f.len() as u32);
        pos_js.copy_from(&positions_f);
        Reflect::set(&out, &"positions".into(), &pos_js)?;

        let nor_js = Float32Array::new_with_length(normals_f.len() as u32);
        nor_js.copy_from(&normals_f);
        Reflect::set(&out, &"normals".into(), &nor_js)?;

        let morph_js = Float32Array::new_with_length(morph_deltas_f.len() as u32);
        morph_js.copy_from(&morph_deltas_f);
        Reflect::set(&out, &"morphDeltas".into(), &morph_js)?;

        let uvs_js = Float32Array::new_with_length(uvs_f.len() as u32);
        uvs_js.copy_from(&uvs_f);
        Reflect::set(&out, &"uvs".into(), &uvs_js)?;

        let idx_js = Uint32Array::new_with_length(indices.len() as u32);
        idx_js.copy_from(&indices);
        Reflect::set(&out, &"indices".into(), &idx_js)?;

        let bounds = Object::new();
        let center_arr = Array::new();
        center_arr.push(&JsValue::from_f64(center_local2[0]));
        center_arr.push(&JsValue::from_f64(center_local2[1]));
        center_arr.push(&JsValue::from_f64(center_local2[2]));

        Reflect::set(&bounds, &"centerLocal".into(), &center_arr)?;
        Reflect::set(
            &bounds,
            &"boundingRadius".into(),
            &JsValue::from_f64(bounding_radius),
        )?;
        Reflect::set(
            &bounds,
            &"minPlanetRadius".into(),
            &JsValue::from_f64(min_pr),
        )?;
        Reflect::set(
            &bounds,
            &"maxPlanetRadius".into(),
            &JsValue::from_f64(max_pr),
        )?;
        Reflect::set(&out, &"boundsInfo".into(), &bounds)?;

        Ok(out.into())
    }
}

// ---------------------------------------------------------------------------
// Triangular patch generation for CBT leaves
// ---------------------------------------------------------------------------

/// Row start index in the triangular vertex grid.
/// Row `i` of resolution `N` has `(N + 1 - i)` vertices.
fn tri_row_start(n: usize) -> Vec<usize> {
    let mut starts = Vec::with_capacity(n + 2);
    let mut acc = 0usize;
    for i in 0..=n {
        starts.push(acc);
        acc += n + 1 - i;
    }
    starts.push(acc); // sentinel
    starts
}

fn build_triangle_js_output(
    positions_f: &[f32],
    normals_f: &[f32],
    morph_deltas_f: &[f32],
    uvs_f: &[f32],
    indices_u16: Option<&[u16]>,
    indices_u32: Option<&[u32]>,
    center_local: [f64; 3],
    bounding_radius: f64,
    min_pr: f64,
    max_pr: f64,
) -> Result<JsValue, JsValue> {
    let out = Object::new();

    let pos_js = Float32Array::new_with_length(positions_f.len() as u32);
    pos_js.copy_from(positions_f);
    Reflect::set(&out, &"positions".into(), &pos_js)?;

    let nor_js = Float32Array::new_with_length(normals_f.len() as u32);
    nor_js.copy_from(normals_f);
    Reflect::set(&out, &"normals".into(), &nor_js)?;

    let morph_js = Float32Array::new_with_length(morph_deltas_f.len() as u32);
    morph_js.copy_from(morph_deltas_f);
    Reflect::set(&out, &"morphDeltas".into(), &morph_js)?;

    let uvs_js = Float32Array::new_with_length(uvs_f.len() as u32);
    uvs_js.copy_from(uvs_f);
    Reflect::set(&out, &"uvs".into(), &uvs_js)?;

    if let Some(idx) = indices_u16 {
        let idx_js = Uint16Array::new_with_length(idx.len() as u32);
        idx_js.copy_from(idx);
        Reflect::set(&out, &"indices".into(), &idx_js)?;
    } else if let Some(idx) = indices_u32 {
        let idx_js = Uint32Array::new_with_length(idx.len() as u32);
        idx_js.copy_from(idx);
        Reflect::set(&out, &"indices".into(), &idx_js)?;
    }

    let bounds = Object::new();
    let center_arr = Array::new();
    center_arr.push(&JsValue::from_f64(center_local[0]));
    center_arr.push(&JsValue::from_f64(center_local[1]));
    center_arr.push(&JsValue::from_f64(center_local[2]));
    Reflect::set(&bounds, &"centerLocal".into(), &center_arr)?;
    Reflect::set(&bounds, &"boundingRadius".into(), &JsValue::from_f64(bounding_radius))?;
    Reflect::set(&bounds, &"minPlanetRadius".into(), &JsValue::from_f64(min_pr))?;
    Reflect::set(&bounds, &"maxPlanetRadius".into(), &JsValue::from_f64(max_pr))?;
    Reflect::set(&out, &"boundsInfo".into(), &bounds)?;

    Ok(out.into())
}

#[wasm_bindgen]
pub fn build_triangle_chunk(
    v0_x: f64, v0_y: f64, v0_z: f64,
    v1_x: f64, v1_y: f64, v1_z: f64,
    v2_x: f64, v2_y: f64, v2_z: f64,
    resolution: u32,
    radius: f64,
    seed: i32,
    octaves: u32,
    base_frequency: f64,
    base_amplitude: f64,
    lacunarity: f64,
    persistence: f64,
    global_amp: f64,
) -> Result<JsValue, JsValue> {
    console_error_panic_hook::set_once();

    let n = resolution as usize;
    let vert_count = (n + 1) * (n + 2) / 2;
    let tri_count = n * n;
    let index_count = tri_count * 3;

    let simplex = OpenSimplex::new(seed as u32);
    let row_start = tri_row_start(n);

    let tv0 = [v0_x, v0_y, v0_z];
    let tv1 = [v1_x, v1_y, v1_z];
    let tv2 = [v2_x, v2_y, v2_z];

    let mut positions_f = vec![0f32; vert_count * 3];
    let mut normals_f = vec![0f32; vert_count * 3];
    let mut morph_deltas_f = vec![0f32; vert_count * 3];
    let mut uvs_f = vec![0f32; vert_count * 2];
    let mut verts = vec![[0.0f64; 3]; vert_count];

    let mut min_pr = f64::INFINITY;
    let mut max_pr = -f64::INFINITY;

    // PASS 1: vertices via barycentric interpolation + sphere projection + noise
    for i in 0..=n {
        let cols = n - i;
        for j in 0..=cols {
            let a = i as f64 / n as f64; // weight for v1
            let b = j as f64 / n as f64; // weight for v2
            let c = 1.0 - a - b;         // weight for v0

            // Interpolate on the flat triangle
            let interp = add3(add3(scale3(tv0, c), scale3(tv1, a)), scale3(tv2, b));

            // Project onto unit sphere
            let unit = normalize3(interp);

            // Fractal noise displacement
            let f = fractal_noise(
                &simplex, unit[0], unit[1], unit[2],
                octaves, base_frequency, base_amplitude, lacunarity, persistence,
            );
            let elevation = f * global_amp;
            let pr = radius + elevation;

            if pr < min_pr { min_pr = pr; }
            if pr > max_pr { max_pr = pr; }

            let pos = scale3(unit, pr);
            let idx = row_start[i] + j;
            verts[idx] = pos;

            let p_off = idx * 3;
            positions_f[p_off]     = pos[0] as f32;
            positions_f[p_off + 1] = pos[1] as f32;
            positions_f[p_off + 2] = pos[2] as f32;

            // Initial radial normal
            normals_f[p_off]     = (pos[0] / pr) as f32;
            normals_f[p_off + 1] = (pos[1] / pr) as f32;
            normals_f[p_off + 2] = (pos[2] / pr) as f32;

            // Spherical UV
            let uu = ((pos[0].atan2(pos[2]) + PI) / (2.0 * PI)) as f32;
            let vv = ((pos[1] / pr).acos() / PI) as f32;
            let uv_off = idx * 2;
            uvs_f[uv_off]     = uu;
            uvs_f[uv_off + 1] = vv;
        }
    }

    // PASS 2: morph deltas — snap to even barycentric grid (half resolution)
    for i in 0..=n {
        let cols = n - i;
        for j in 0..=cols {
            let idx = row_start[i] + j;

            let i0 = (i / 2) * 2;
            let j0 = (j / 2) * 2;

            // Clamp to valid triangle range
            let i1 = (i0 + 2).min(n);
            let j1_max = n - i0;
            let j1 = (j0 + 2).min(j1_max);

            let fx = if j1 == j0 { 0.0 } else { (j - j0) as f64 / (j1 - j0) as f64 };
            let fy = if i1 == i0 { 0.0 } else { (i - i0) as f64 / (i1 - i0) as f64 };

            // Bilinear from coarse corners (clamped to valid indices)
            let j0c = j0.min(n - i0);
            let j1c = j1.min(n - i0);
            let j0c1 = j0.min(n - i1);
            let j1c1 = j1.min(n - i1);

            let v00 = verts[row_start[i0] + j0c];
            let v10 = verts[row_start[i0] + j1c];
            let v01 = verts[row_start[i1] + j0c1];
            let v11 = verts[row_start[i1] + j1c1];

            let row0 = lerp3(v00, v10, fx);
            let row1 = lerp3(v01, v11, fx);
            let coarse = lerp3(row0, row1, fy);
            let delta = sub3(coarse, verts[idx]);

            let p_off = idx * 3;
            morph_deltas_f[p_off]     = delta[0] as f32;
            morph_deltas_f[p_off + 1] = delta[1] as f32;
            morph_deltas_f[p_off + 2] = delta[2] as f32;
        }
    }

    // Bounding sphere
    let centroid = scale3(add3(add3(tv0, tv1), tv2), 1.0 / 3.0);
    let dir = normalize3(centroid);
    let center_r = 0.5 * (min_pr + max_pr);
    let center_local = scale3(dir, center_r);

    let mut max_d2 = 0.0f64;
    for v in &verts {
        let d = sub3(*v, center_local);
        let d2 = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
        if d2 > max_d2 { max_d2 = d2; }
    }
    let bounding_radius = max_d2.sqrt();

    // PASS 3: indices + averaged normals
    let mut acc = vec![[0.0f64; 3]; vert_count];
    let mut cnt = vec![0u32; vert_count];

    let use_u16 = vert_count <= 65535;

    if use_u16 {
        let mut indices: Vec<u16> = Vec::with_capacity(index_count);

        for i in 0..n {
            let cols = n - i;
            for j in 0..cols {
                let a = (row_start[i] + j) as u16;
                let b = (row_start[i] + j + 1) as u16;
                let d = (row_start[i + 1] + j) as u16;

                // Upper triangle
                indices.extend_from_slice(&[a, b, d]);

                let na = a as usize;
                let nb = b as usize;
                let nd = d as usize;
                let n1 = tri_normal(verts[na], verts[nb], verts[nd]);
                acc[na] = add3(acc[na], n1); cnt[na] += 1;
                acc[nb] = add3(acc[nb], n1); cnt[nb] += 1;
                acc[nd] = add3(acc[nd], n1); cnt[nd] += 1;

                // Lower triangle (if not last column)
                if j < cols - 1 {
                    let e = (row_start[i + 1] + j + 1) as u16;
                    indices.extend_from_slice(&[b, e, d]);

                    let ne = e as usize;
                    let n2 = tri_normal(verts[nb], verts[ne], verts[nd]);
                    acc[nb] = add3(acc[nb], n2); cnt[nb] += 1;
                    acc[ne] = add3(acc[ne], n2); cnt[ne] += 1;
                    acc[nd] = add3(acc[nd], n2); cnt[nd] += 1;
                }
            }
        }

        // Average normals
        for i in 0..vert_count {
            if cnt[i] > 0 {
                let inv = 1.0 / (cnt[i] as f64);
                let nn = normalize3(scale3(acc[i], inv));
                let off = i * 3;
                normals_f[off]     = nn[0] as f32;
                normals_f[off + 1] = nn[1] as f32;
                normals_f[off + 2] = nn[2] as f32;
            }
        }

        build_triangle_js_output(
            &positions_f, &normals_f, &morph_deltas_f, &uvs_f,
            Some(&indices), None,
            center_local, bounding_radius, min_pr, max_pr,
        )
    } else {
        let mut indices: Vec<u32> = Vec::with_capacity(index_count);

        for i in 0..n {
            let cols = n - i;
            for j in 0..cols {
                let a = (row_start[i] + j) as u32;
                let b = (row_start[i] + j + 1) as u32;
                let d = (row_start[i + 1] + j) as u32;

                indices.extend_from_slice(&[a, b, d]);

                let na = a as usize;
                let nb = b as usize;
                let nd = d as usize;
                let n1 = tri_normal(verts[na], verts[nb], verts[nd]);
                acc[na] = add3(acc[na], n1); cnt[na] += 1;
                acc[nb] = add3(acc[nb], n1); cnt[nb] += 1;
                acc[nd] = add3(acc[nd], n1); cnt[nd] += 1;

                if j < cols - 1 {
                    let e = (row_start[i + 1] + j + 1) as u32;
                    indices.extend_from_slice(&[b, e, d]);

                    let ne = e as usize;
                    let n2 = tri_normal(verts[nb], verts[ne], verts[nd]);
                    acc[nb] = add3(acc[nb], n2); cnt[nb] += 1;
                    acc[ne] = add3(acc[ne], n2); cnt[ne] += 1;
                    acc[nd] = add3(acc[nd], n2); cnt[nd] += 1;
                }
            }
        }

        for i in 0..vert_count {
            if cnt[i] > 0 {
                let inv = 1.0 / (cnt[i] as f64);
                let nn = normalize3(scale3(acc[i], inv));
                let off = i * 3;
                normals_f[off]     = nn[0] as f32;
                normals_f[off + 1] = nn[1] as f32;
                normals_f[off + 2] = nn[2] as f32;
            }
        }

        build_triangle_js_output(
            &positions_f, &normals_f, &morph_deltas_f, &uvs_f,
            None, Some(&indices),
            center_local, bounding_radius, min_pr, max_pr,
        )
    }
}
