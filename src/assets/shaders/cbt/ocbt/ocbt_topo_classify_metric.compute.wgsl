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

@group(0) @binding(2)  var<storage, read>       heapID         : array<vec2<u32>>;
@group(0) @binding(5)  var<storage, read_write> bisectorData   : array<u32>;
@group(0) @binding(6)  var<storage, read_write> classification : array<atomic<u32>>;
@group(0) @binding(17) var<uniform>             cp             : ClassifyParams;
@group(0) @binding(19) var<storage, read>       positions      : array<f32>;

fn corner(slot : u32, c : u32) -> vec3<f32> {
    let b = slot * 9u + c * 3u;
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

    let radius = cp.camRadius.w;
    let cam = cp.camRadius.xyz;
    let focal = cp.thresh.x;
    let splitT = cp.thresh.y;
    let mergeT = cp.thresh.z;
    let cullMinDot = cp.thresh.w;
    let maxLevel = cp.limits.x;

    let d0 = corner(id, 0u);
    let d1 = corner(id, 1u);
    let d2 = corner(id, 2u);
    let p0 = d0 * radius;
    let p1 = d1 * radius;
    let p2 = d2 * radius;
    let centroidDir = normalize(d0 + d1 + d2);
    let worldC = centroidDir * radius;

    // Backside / horizon cull: leaves whose centroid faces away from the camera.
    let camDir = normalize(cam);
    let facing = dot(centroidDir, camDir);
    let culled = facing < cullMinDot;

    // Longest-edge screen size in pixels.
    let e = max(max(length(p0 - p1), length(p1 - p2)), length(p2 - p0));
    let dist = max(length(worldC - cam), 1.0);
    let screenPx = e * focal / dist;

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
