import { Vector3 } from '@babylonjs/core';
import { describe, expect, it } from 'vitest';
import {
    classifyLeaves,
    classifySplitCandidates,
    measureLeafProjectedAreas,
} from './cbt_classify';
import { emitMeshFromLeaves } from './cbt_emit';
import { CbtState } from './cbt_state';
import { makeClassifyParams, makeLeafSet } from './__fixtures__/cbt_fixtures';

const RADIUS = 1000;
const MAX_DEPTH = 24;

describe('CBT invariants — classification', () => {
    it('split candidate order is deterministic for identical input', () => {
        const leaves = makeLeafSet(2000, RADIUS, MAX_DEPTH);
        const params = makeClassifyParams(leaves, RADIUS);

        const a = classifySplitCandidates(params).map((c) => c.nodeId);
        const b = classifySplitCandidates(params).map((c) => c.nodeId);

        expect(a).toEqual(b);
    });

    it('candidates are sorted by descending projected area', () => {
        const leaves = makeLeafSet(2000, RADIUS, MAX_DEPTH);
        const candidates = classifySplitCandidates(makeClassifyParams(leaves, RADIUS));

        for (let i = 1; i < candidates.length; i++) {
            expect(candidates[i - 1].projectedAreaPx2).toBeGreaterThanOrEqual(
                candidates[i].projectedAreaPx2
            );
        }
    });

    it('reproduces the screen-space area metric independently', () => {
        // Single known leaf, identity render parent, camera on +Z axis.
        const v0 = new Vector3(100, 0, 900);
        const v1 = new Vector3(0, 100, 900);
        const v2 = new Vector3(-100, -100, 900);
        const leaf = {
            id: 1,
            level: 0,
            parentId: null,
            leftId: null,
            rightId: null,
            v0,
            v1,
            v2,
            isLeaf: true,
        };

        const viewportHeightPx = 1080;
        const cameraFovRadians = 1.2;
        const cameraDistance = 2000;
        const metrics = measureLeafProjectedAreas({
            leaves: [leaf],
            cameraWorldDouble: new Vector3(0, 0, cameraDistance),
            planetCenterWorldDouble: Vector3.Zero(),
            renderParentWorldMatrix: makeClassifyParams([leaf], RADIUS).renderParentWorldMatrix,
            viewportHeightPx,
            cameraFovRadians,
        });

        // Independent recompute.
        const focal = viewportHeightPx / (2 * Math.tan(cameraFovRadians * 0.5));
        const cx = (v0.x + v1.x + v2.x) / 3;
        const cy = (v0.y + v1.y + v2.y) / 3;
        const cz = (v0.z + v1.z + v2.z) / 3;
        const dist = Math.max(1, Vector3.Distance(new Vector3(0, 0, cameraDistance), new Vector3(cx, cy, cz)));
        const areaWorld = Vector3.Cross(v1.subtract(v0), v2.subtract(v0)).length() * 0.5;
        const expected = (areaWorld * focal * focal) / (dist * dist);

        expect(metrics[0].projectedAreaPx2).toBeCloseTo(expected, 3);
    });
});

describe('CBT invariants — single-pass classify (Phase 1)', () => {
    // Build a tree with real parent/child structure so merge aggregation is exercised.
    function grownLeaves() {
        const state = new CbtState(RADIUS, MAX_DEPTH);
        for (let round = 0; round < 5; round++) {
            const ids = state.getLeafNodes().map((l) => l.id);
            state.splitByPriority(ids, ids.length);
        }
        return state.getLeafNodes();
    }

    it('split candidates match classifySplitCandidates exactly', () => {
        const leaves = grownLeaves();
        const params = makeClassifyParams(leaves, RADIUS, { cameraDistance: RADIUS * 1.1 });

        const single = classifyLeaves(params).splitCandidates;
        const legacy = classifySplitCandidates(params);

        expect(single).toEqual(legacy);
    });

    it('merge parents match the legacy two-pass aggregation exactly', () => {
        const leaves = grownLeaves();
        // Far camera → small projected areas → merge eligibility.
        const params = makeClassifyParams(leaves, RADIUS, { cameraDistance: RADIUS * 40 });

        const single = classifyLeaves(params).mergeParents;

        // Replicate the old scheduler aggregation from measureLeafProjectedAreas.
        const metrics = measureLeafProjectedAreas({
            leaves: params.leaves,
            cameraWorldDouble: params.cameraWorldDouble,
            planetCenterWorldDouble: params.planetCenterWorldDouble,
            renderParentWorldMatrix: params.renderParentWorldMatrix,
            viewportHeightPx: params.viewportHeightPx,
            cameraFovRadians: params.cameraFovRadians,
        });
        const mergeThreshold = params.splitThresholdPx2 * params.splitHysteresis;
        const agg = new Map<number, { children: number; maxAreaPx2: number }>();
        for (const m of metrics) {
            if (m.parentId === null) continue;
            const prev = agg.get(m.parentId) ?? { children: 0, maxAreaPx2: 0 };
            prev.children++;
            prev.maxAreaPx2 = Math.max(prev.maxAreaPx2, m.projectedAreaPx2);
            agg.set(m.parentId, prev);
        }
        const legacy = Array.from(agg.entries())
            .filter(([, a]) => a.children === 2 && a.maxAreaPx2 <= mergeThreshold)
            .sort((a, b) => a[1].maxAreaPx2 - b[1].maxAreaPx2)
            .map(([id]) => id);

        expect(single).toEqual(legacy);
        expect(legacy.length).toBeGreaterThan(0); // the fixture actually exercises merges
    });
});

describe('CBT invariants — backside culling (Phase 2)', () => {
    const CULL_MIN_DOT = -0.05;

    function frontFacing(leaf: { v0: Vector3; v1: Vector3; v2: Vector3 }, cameraDistance: number): boolean {
        const cx = (leaf.v0.x + leaf.v1.x + leaf.v2.x) / 3;
        const cy = (leaf.v0.y + leaf.v1.y + leaf.v2.y) / 3;
        const cz = (leaf.v0.z + leaf.v1.z + leaf.v2.z) / 3;
        // radial (outward normal) vs direction to camera at (0,0,cameraDistance).
        const rx = cx, ry = cy, rz = cz;
        const tx = -cx, ty = -cy, tz = cameraDistance - cz;
        const dot = rx * tx + ry * ty + rz * tz;
        const rl = Math.hypot(rx, ry, rz);
        const tl = Math.hypot(tx, ty, tz);
        return dot >= CULL_MIN_DOT * rl * tl;
    }

    it('culling only removes split candidates (subset of un-culled)', () => {
        const leaves = makeLeafSet(3000, RADIUS, MAX_DEPTH);
        const base = makeClassifyParams(leaves, RADIUS, { cameraDistance: RADIUS * 1.2 });

        const off = new Set(
            classifyLeaves({ ...base, cullBackface: false }).splitCandidates.map((c) => c.nodeId)
        );
        const on = classifyLeaves({ ...base, cullBackface: true, cullMinDot: CULL_MIN_DOT })
            .splitCandidates.map((c) => c.nodeId);

        for (const id of on) expect(off.has(id)).toBe(true);
        expect(on.length).toBeLessThan(off.size); // the far hemisphere is actually removed
    });

    it('every culled (removed) leaf is genuinely back-facing', () => {
        const leaves = makeLeafSet(3000, RADIUS, MAX_DEPTH);
        const cameraDistance = RADIUS * 1.2;
        const base = makeClassifyParams(leaves, RADIUS, { cameraDistance });
        const byId = new Map(leaves.map((l) => [l.id, l]));

        const off = classifyLeaves({ ...base, cullBackface: false }).splitCandidates.map((c) => c.nodeId);
        const on = new Set(
            classifyLeaves({ ...base, cullBackface: true, cullMinDot: CULL_MIN_DOT })
                .splitCandidates.map((c) => c.nodeId)
        );

        const removed = off.filter((id) => !on.has(id));
        expect(removed.length).toBeGreaterThan(0);
        for (const id of removed) {
            expect(frontFacing(byId.get(id)!, cameraDistance)).toBe(false);
        }
    });

    it('produces a materially smaller tree at a fixed camera pose (the structural win)', () => {
        function simulateLeafCount(cull: boolean): number {
            const state = new CbtState(RADIUS, MAX_DEPTH);
            for (let round = 0; round < 8; round++) {
                const leaves = state.getLeafNodes();
                const params = makeClassifyParams(leaves, RADIUS, { cameraDistance: RADIUS * 1.1 });
                const { splitCandidates } = classifyLeaves({
                    ...params,
                    cullBackface: cull,
                    cullMinDot: CULL_MIN_DOT,
                });
                state.splitByPriority(splitCandidates.map((c) => c.nodeId), 256);
            }
            return state.leafCount;
        }

        const noCull = simulateLeafCount(false);
        const culled = simulateLeafCount(true);

        // Back hemisphere stops subdividing → meaningfully fewer leaves.
        expect(culled).toBeLessThan(noCull * 0.75);
    });

    it('merges are unaffected by culling (back-hemisphere detail still reclaimable)', () => {
        const leaves = makeLeafSet(3000, RADIUS, MAX_DEPTH);
        const base = makeClassifyParams(leaves, RADIUS, { cameraDistance: RADIUS * 40 });

        const off = classifyLeaves({ ...base, cullBackface: false }).mergeParents;
        const on = classifyLeaves({ ...base, cullBackface: true }).mergeParents;

        expect(on).toEqual(off);
    });
});

describe('CBT invariants — topology', () => {
    it('conserves leaf count: +1 per split', () => {
        const state = new CbtState(RADIUS, MAX_DEPTH);
        const before = state.leafCount;
        const ids = state.getLeafNodes().map((l) => l.id);
        const splits = state.splitByPriority(ids, ids.length);
        expect(state.leafCount).toBe(before + splits);
    });

    it('conserves leaf count: -1 per merge, restoring the parent as a leaf', () => {
        const state = new CbtState(RADIUS, MAX_DEPTH);
        const target = state.getLeafNodes()[0];
        state.splitByPriority([target.id], 1);
        expect(state.leafCount).toBe(9);

        // The split node is no longer a leaf; its children are.
        const leafIdsAfterSplit = new Set(state.getLeafNodes().map((l) => l.id));
        expect(leafIdsAfterSplit.has(target.id)).toBe(false);

        const merged = state.mergeByParentPriority([target.id], 1);
        expect(merged).toBe(1);
        expect(state.leafCount).toBe(8);

        // Parent is a leaf again; no orphaned children remain.
        const leafIdsAfterMerge = new Set(state.getLeafNodes().map((l) => l.id));
        expect(leafIdsAfterMerge.has(target.id)).toBe(true);
    });

    it('never produces duplicate leaf ids', () => {
        const leaves = makeLeafSet(5000, RADIUS, MAX_DEPTH);
        const ids = new Set(leaves.map((l) => l.id));
        expect(ids.size).toBe(leaves.length);
    });
});

describe('CBT invariants — emitted mesh', () => {
    it('emits exactly 3 vertices and 3 indices per leaf', () => {
        const leaves = makeLeafSet(1000, RADIUS, MAX_DEPTH);
        const mesh = emitMeshFromLeaves(leaves, RADIUS);
        expect(mesh.positions.length).toBe(leaves.length * 3 * 3);
        expect(mesh.indices.length).toBe(leaves.length * 3);
    });

    it('all index references are in range', () => {
        const leaves = makeLeafSet(1000, RADIUS, MAX_DEPTH);
        const mesh = emitMeshFromLeaves(leaves, RADIUS);
        const vertexCount = mesh.positions.length / 3;
        for (let i = 0; i < mesh.indices.length; i++) {
            expect(mesh.indices[i]).toBeLessThan(vertexCount);
        }
    });

    it('produces no degenerate (zero-area) triangles', () => {
        const leaves = makeLeafSet(2000, RADIUS, MAX_DEPTH);
        const mesh = emitMeshFromLeaves(leaves, RADIUS, { noise: null });
        const p = mesh.positions;
        for (let t = 0; t < mesh.indices.length; t += 3) {
            const a = mesh.indices[t] * 3;
            const b = mesh.indices[t + 1] * 3;
            const c = mesh.indices[t + 2] * 3;
            const e0 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
            const e1 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
            const cross = [
                e0[1] * e1[2] - e0[2] * e1[1],
                e0[2] * e1[0] - e0[0] * e1[2],
                e0[0] * e1[1] - e0[1] * e1[0],
            ];
            const area = 0.5 * Math.hypot(cross[0], cross[1], cross[2]);
            expect(area).toBeGreaterThan(0);
        }
    });

    it('has consistent winding (all triangles face the same way relative to the surface)', () => {
        const leaves = makeLeafSet(2000, RADIUS, MAX_DEPTH);
        const mesh = emitMeshFromLeaves(leaves, RADIUS, { noise: null });
        const p = mesh.positions;
        let positive = 0;
        let negative = 0;
        for (let t = 0; t < mesh.indices.length; t += 3) {
            const a = mesh.indices[t] * 3;
            const b = mesh.indices[t + 1] * 3;
            const c = mesh.indices[t + 2] * 3;
            const e0 = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
            const e1 = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
            const nx = e0[1] * e1[2] - e0[2] * e1[1];
            const ny = e0[2] * e1[0] - e0[0] * e1[2];
            const nz = e0[0] * e1[1] - e0[1] * e1[0];
            // Centroid (≈ outward radial direction for a sphere-projected tri).
            const cx = (p[a] + p[b] + p[c]) / 3;
            const cy = (p[a + 1] + p[b + 1] + p[c + 1]) / 3;
            const cz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
            const dot = nx * cx + ny * cy + nz * cz;
            if (dot >= 0) positive++;
            else negative++;
        }
        // Consistent winding ⇒ one bucket is empty.
        expect(Math.min(positive, negative)).toBe(0);
    });
});
