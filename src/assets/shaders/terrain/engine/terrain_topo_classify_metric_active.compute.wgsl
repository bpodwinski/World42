// TERRAIN Classify — ACTIVE-LIST metric variant (one thread per ACTIVE slot).
// Identical to terrain_topo_classify_metric except the slot ID is read from
// activeSlots[i] (the bisectorIndices compacted list). Dispatched O(active)
// via dispatchIndirect using record 8 (ARG.CLASSIFY) written by PrepareIndirect
// after each compact.
//
// Composed after: engineWgslPreamble + terrain_u64.wgsl + terrain_topo_common.wgsl.

struct ClassifyParams {
    camRadius : vec4<f32>, // xyz = camera in planet-local sim units, w = planet radius
    thresh    : vec4<f32>, // x = focal px, y = splitThreshold px, z = mergeThreshold px, w = cullMinDot
    limits    : vec4<f32>  // x = maxLevel, y = minLevel (as f32)
};

struct FrustumParams {
    planes : array<vec4<f32>, 6>,
    ctrl   : vec4<f32>
};

@group(0) @binding(2)  var<storage, read>       heapID         : array<vec2<u32>>;
@group(0) @binding(5)  var<storage, read_write> bisectorData   : array<u32>;
@group(0) @binding(6)  var<storage, read_write> classification : array<atomic<u32>>;
@group(0) @binding(13) var<storage, read>       activeSlots    : array<u32>;
@group(0) @binding(17) var<uniform>             cp             : ClassifyParams;
@group(0) @binding(19) var<storage, read>       positions      : array<f32>;
@group(0) @binding(20) var<uniform>             fp             : FrustumParams;
@group(0) @binding(21) var<storage, read>       activeCount    : array<u32>;

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
    let i = linear_id(gid, nwg.x);
    if (i >= activeCount[0]) { return; }
    let id = activeSlots[i];

    let heap = heapID[id];
    // compact guarantees alive slots; guard kept as safety net
    if (heap_is_zero(heap)) { return; }
    let depth = u64_depth(heap);
    let level = f32(depth - BASE_DEPTH);

    let b = id * BD_WORDS;
    bisectorData[b + BD_PATTERN]     = NO_SPLIT;
    bisectorData[b + BD_STATE]       = ST_UNCHANGED;
    bisectorData[b + BD_PROBLEMATIC] = TERRAIN_INVALID;
    bisectorData[b + BD_FLAGS]       = FLAG_VISIBLE;

    let cam = cp.camRadius.xyz;
    let focal = cp.thresh.x;
    let splitT = cp.thresh.y;
    let mergeT = cp.thresh.z;
    let cullMinDot = cp.thresh.w;
    let maxLevel = cp.limits.x;
    let minLevel = cp.limits.y;

    let r0 = corner_rel(id, 0u);
    let r1 = corner_rel(id, 1u);
    let r2 = corner_rel(id, 2u);
    let centroidRel = (r0 + r1 + r2) * (1.0 / 3.0);

    let d0 = corner_dir(id, 0u);
    let d1 = corner_dir(id, 1u);
    let d2 = corner_dir(id, 2u);
    let radius = cp.camRadius.w;
    let e = radius * max(max(length(d0 - d1), length(d1 - d2)), length(d2 - d0));
    let dist = max(length(centroidRel), 1.0);
    let screenPx = e * focal / dist;

    let camDir = normalize(cam);
    let facing = max(dot(d0, camDir), max(dot(d1, camDir), dot(d2, camDir)));
    var culled = facing < cullMinDot;

    if (fp.ctrl.x > 0.5) {
        let margin = e * fp.ctrl.y + fp.ctrl.z;
        for (var fi = 0u; fi < 6u; fi = fi + 1u) {
            let pl = fp.planes[fi];
            let fd0 = dot(pl.xyz, r0) + pl.w;
            let fd1 = dot(pl.xyz, r1) + pl.w;
            let fd2 = dot(pl.xyz, r2) + pl.w;
            if (fd0 < -margin && fd1 < -margin && fd2 < -margin) { culled = true; break; }
        }
    }

    let belowFloor = level < minLevel;
    if (level < maxLevel && (belowFloor || (!culled && screenPx > splitT))) {
        bisectorData[b + BD_STATE] = ST_BISECT;
        let slot = atomicAdd(&classification[SPLIT_COUNTER], 1u);
        atomicStore(&classification[CLASSIFY_COUNTER_OFFSET + slot], id);
    } else if (level > minLevel && (culled || screenPx < mergeT)) {
        bisectorData[b + BD_STATE] = ST_SIMPLIFY;
        if (u64_bit(heap, 0u) == 0u) {
            let slot = atomicAdd(&classification[SIMPLIFY_COUNTER], 1u);
            atomicStore(&classification[CLASSIFY_COUNTER_OFFSET + TERRAIN_CAPACITY + slot], id);
        }
    }
}
