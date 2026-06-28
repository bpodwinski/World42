import { FrameGraphTask } from '@babylonjs/core';
import type { FrameGraph, FrameGraphContext } from '@babylonjs/core';

/**
 * Frame Graph task that drives the OCBT terrain compute (topology split/merge + EvaluateLEB + draw
 * compaction) inside the graph's execution timeline, immediately before the scene-render task.
 *
 * Why a single wrapper rather than one `FrameGraphComputeShaderTask` per dispatch: the OCBT pipeline is
 * dynamically gated (0 passes on a still camera), uses indirect dispatch + ping-pong neighbor buffers +
 * a variable-length reduce loop, and round-robins across planets under a per-frame budget — none of
 * which fits the build-once declarative graph. The wrapper keeps that dynamic logic in
 * `CbtScheduler.runCompute()` and just invokes it from the correct point in the frame.
 *
 * ORDERING CONTRACT — do not reorder. The compute writes the OCBT STORAGE buffers (heap / positions /
 * draw-index list) that the scene-render vertex shader reads. The frame graph orders tasks only by
 * TEXTURE-handle dependencies, so it cannot see this storage-buffer dependency; correctness relies on
 * this task being added to the graph BEFORE the object-render task. Both record into the same WebGPU
 * command encoder in task order (compute pass then render pass), so the dispatch lands before the draw.
 */
export class FrameGraphOcbtComputeTask extends FrameGraphTask {
    constructor(
        name: string,
        frameGraph: FrameGraph,
        private readonly runCompute: () => void
    ) {
        super(name, frameGraph);
    }

    /** Per-planet sources self-gate on their own readiness, so the graph build never waits on compute. */
    public override isReady(): boolean {
        return true;
    }

    public override getClassName(): string {
        return 'FrameGraphOcbtComputeTask';
    }

    public override record(): void {
        const pass = this._frameGraph.addPass(this.name);
        pass.setExecuteFunc((context: FrameGraphContext) => {
            // Nest the per-shader OCBT passes under one named region for webgpu-inspector / GPU traces.
            context.pushDebugGroup('OCBT compute');
            this.runCompute();
            context.popDebugGroup();
        });
        // Disabled twin: the framework records this no-op pass when the task is disabled.
        const passDisabled = this._frameGraph.addPass(`${this.name}_disabled`, true);
        passDisabled.setExecuteFunc(() => {});
    }
}
