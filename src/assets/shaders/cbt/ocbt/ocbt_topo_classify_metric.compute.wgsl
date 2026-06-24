// OCBT Classify pass — CAMERA METRIC variant (one thread per pool slot). The render
// path's replacement for the deterministic faceTarget predicate: refine a leaf while
// its longest edge projects to more than `splitThreshold` pixels, coarsen it below
// `mergeThreshold` (hysteresis), backside-cull leaves beyond the horizon, and cap at
// `maxLevel`. Same classification protocol as the predicate variant (split list at
// SPLIT_COUNTER, simplify list at SIMPLIFY area; per-slot BisectorData reset) so the
// Split / PrepareSimplify / ... passes are shared verbatim.
//
// Reads the EvaluateLEB positions buffer (last frame's decoded unit-dir corners) so
// it needs no LEB decode itself — the topology only changes at frame end and eval
// runs after, so positions match the current heap ids at classify time.
//
// Composed after: engineWgslPreamble + ocbt_u64.wgsl + common.

struct ClassifyParams {
    camRadius : vec4<f32>, // xyz = camera in planet-local sim units, w = planet radius
    thresh    : vec4<f32>, // x = focal px, y = splitThreshold px, z = mergeThreshold px, w = cullMinDot
    limits    : vec4<f32>  // x = maxLevel (as f32)
};

// Camera frustum, EXPRESSED IN CAMERA-RELATIVE PLANET-LOCAL SPACE (the same space as
// the positions buffer). The CPU rotates each render-space plane normal by R^T (the
// inverse of the planet world rotation) and keeps d, so the test is a plain dot here:
// a leaf is fully outside when dot(n, centroidRel) + d < -(edge * guard) for any plane.
// Inward normals (World42 convention): inside => dot >= 0.
struct FrustumParams {
    planes : array<vec4<f32>, 6>, // xyz = local-space normal, w = d
    ctrl   : vec4<f32>            // x = enabled (0/1), y = guard scale (edge multiplier)
};

@group(0) @binding(2)  var<storage, read>       heapID         : array<vec2<u32>>;
@group(0) @binding(5)  var<storage, read_write> bisectorData   : array<u32>;
@group(0) @binding(6)  var<storage, read_write> classification : array<atomic<u32>>;
@group(0) @binding(17) var<uniform>             cp             : ClassifyParams;
@group(0) @binding(19) var<storage, read>       positions      : array<f32>;
@group(0) @binding(20) var<uniform>             fp             : FrustumParams;

// EvaluateLEB (f64 variant) writes 18 f32/slot: per corner [relative.xyz, dir.xyz].
// `relative` is the camera-relative planet-local position (so |relative| = distance to
// camera, and corner-to-corner differences are exact edge vectors). `dir` is the unit
// surface direction (for the backside cull).
fn corner_rel(slot : u32, c : u32) -> vec3<f32> {
    let b = slot * 18u + c * 6u;
    return vec3<f32>(positions[b], positions[b + 1u], positions[b + 2u]);
}
fn corner_dir(slot : u32, c : u32) -> vec3<f32> {
    let b = slot * 18u + c * 6u + 3u;
    return vec3<f32>(positions[b], positions[b + 1u], positions[b + 2u]);
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid : vec3<u32>,
        @builtin(num_workgroups) nwg : vec3<u32>) {
    let id = linear_id(gid, nwg.x);
    if (id >= OCBT_CAPACITY) { return; }

    let heap = heapID[id];
    if (heap_is_zero(heap)) { return; }
    let depth = u64_depth(heap);
    let level = f32(depth - BASE_DEPTH);

    // Reset per-frame fields (this thread owns its slot).
    let b = id * BD_WORDS;
    bisectorData[b + BD_PATTERN]     = NO_SPLIT;
    bisectorData[b + BD_STATE]       = ST_UNCHANGED;
    bisectorData[b + BD_PROBLEMATIC] = OCBT_INVALID;
    bisectorData[b + BD_FLAGS]       = FLAG_VISIBLE;

    let cam = cp.camRadius.xyz;
    let focal = cp.thresh.x;
    let splitT = cp.thresh.y;
    let mergeT = cp.thresh.z;
    let cullMinDot = cp.thresh.w;
    let maxLevel = cp.limits.x;

    // Camera-relative corner positions (|rel| = distance to camera).
    let r0 = corner_rel(id, 0u);
    let r1 = corner_rel(id, 1u);
    let r2 = corner_rel(id, 2u);
    let centroidRel = (r0 + r1 + r2) * (1.0 / 3.0);

    // Longest-edge screen size in pixels (edge vectors are exact corner differences).
    let e = max(max(length(r0 - r1), length(r1 - r2)), length(r2 - r0));
    let dist = max(length(centroidRel), 1.0);
    let screenPx = e * focal / dist;

    // Backside / horizon cull from the unit surface directions.
    let centroidDir = normalize(corner_dir(id, 0u) + corner_dir(id, 1u) + corner_dir(id, 2u));
    let camDir = normalize(cam);
    let facing = dot(centroidDir, camDir);
    var culled = facing < cullMinDot;

    // Frustum cull: a leaf fully outside the camera cone (beyond a one-edge guard band)
    // is coarsened so the fixed pool concentrates on what is actually on screen — the
    // only way the visible patch can refine deep (off-screen breadth would otherwise
    // saturate the pool). Conformity (merge engine) keeps the seam to visible leaves watertight.
    if (fp.ctrl.x > 0.5) {
        let margin = e * fp.ctrl.y;
        for (var i = 0u; i < 6u; i = i + 1u) {
            let pl = fp.planes[i];
            if (dot(pl.xyz, centroidRel) + pl.w < -margin) { culled = true; break; }
        }
    }

    if (!culled && screenPx > splitT && level < maxLevel) {
        bisectorData[b + BD_STATE] = ST_BISECT;
        let slot = atomicAdd(&classification[SPLIT_COUNTER], 1u);
        atomicStore(&classification[CLASSIFY_COUNTER_OFFSET + slot], id);
    } else if (level > 0.0 && (culled || screenPx < mergeT)) {
        bisectorData[b + BD_STATE] = ST_SIMPLIFY;
        if (u64_bit(heap, 0u) == 0u) {
            let slot = atomicAdd(&classification[SIMPLIFY_COUNTER], 1u);
            atomicStore(&classification[CLASSIFY_COUNTER_OFFSET + OCBT_CAPACITY + slot], id);
        }
    }
}
