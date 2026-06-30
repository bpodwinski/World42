// One-thread shader: zeros drawCount[0] (the compact atomic cursor) WITHIN the GPU
// command buffer, so the zero executes AFTER classifyActive/copyActive have read the
// previous frame's count and BEFORE compact starts its atomicAdd sequence.
//
// Replaces the CPU-side drawCount.update(0) (queue.writeBuffer) which was submitted to
// the GPU queue BEFORE the current frame's command buffer, causing classifyActive to
// always read 0 and exit early.
//
// Composed after: engineWgslPreamble.

@group(0) @binding(21) var<storage, read_write> drawCount : array<atomic<u32>>;

@compute @workgroup_size(1)
fn main() {
    atomicStore(&drawCount[0], 0u);
}
