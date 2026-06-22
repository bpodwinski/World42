import { describe, expect, it } from 'vitest';
import { classifySplitCandidates } from './cbt_classify';
import { emitMeshFromLeaves } from './cbt_emit';
import { CbtState, type CbtNode } from './cbt_state';
import { makeClassifyParams } from './__fixtures__/cbt_fixtures';

/**
 * Golden master: a fixed seed + fixed camera produces a deterministic tree and
 * mesh. We hash topology and emitted geometry and snapshot the hashes. Any
 * unintended change to splitting, bisection, or emission flips the hash.
 *
 * Phases 1 and 3 are behavior-preserving, so these hashes must NOT change.
 * Phase 2 (culling) intentionally changes the selected leaf set — re-bless the
 * snapshot then, after a visual check.
 */

const GOLD_RADIUS = 1000;
const GOLD_MAX_DEPTH = 24;

/** Round to 4 decimals, normalizing -0 → 0, for stable hashing. */
function q(x: number): string {
    const r = Math.round(x * 1e4) / 1e4;
    return r === 0 ? '0' : String(r);
}

/** FNV-1a over a string → stable 8-hex-digit hash, platform independent. */
function fnv1a(str: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

function centroidKey(leaf: CbtNode): string {
    const cx = (leaf.v0.x + leaf.v1.x + leaf.v2.x) / 3;
    const cy = (leaf.v0.y + leaf.v1.y + leaf.v2.y) / 3;
    const cz = (leaf.v0.z + leaf.v1.z + leaf.v2.z) / 3;
    return `${q(cx)},${q(cy)},${q(cz)}`;
}

// Canonical order: sort leaves by centroid. This makes both hashes independent of
// node-id assignment and leaf iteration order, so they assert the GEOMETRY of the
// tree, not bookkeeping. A structural refactor that preserves geometry (e.g. the
// Map→typed-array pool migration) must keep these hashes unchanged.
function canonical(leaves: ReadonlyArray<CbtNode>): CbtNode[] {
    return [...leaves].sort((a, b) => centroidKey(a).localeCompare(centroidKey(b)));
}

function topologyHash(leaves: ReadonlyArray<CbtNode>): string {
    const rows = canonical(leaves).map((leaf) => `${leaf.level}:${centroidKey(leaf)}`);
    return fnv1a(rows.join('|'));
}

function meshHash(leaves: ReadonlyArray<CbtNode>): string {
    const mesh = emitMeshFromLeaves(canonical(leaves), GOLD_RADIUS);
    let acc = '';
    for (let i = 0; i < mesh.positions.length; i++) acc += q(mesh.positions[i]) + ',';
    acc += '#';
    for (let i = 0; i < mesh.indices.length; i++) acc += mesh.indices[i] + ',';
    return fnv1a(acc);
}

/**
 * Deterministic descent: camera close to the planet, repeatedly classify and
 * split EVERY candidate above threshold. Splitting all candidates (no per-round
 * cap) keeps the resulting leaf set independent of leaf iteration order — so the
 * geometry is determined purely by the classify threshold + bisection, and the
 * hashes are stable across structural refactors (e.g. the typed-array pool).
 */
function runScenario(): CbtState {
    const state = new CbtState(GOLD_RADIUS, GOLD_MAX_DEPTH);

    for (let round = 0; round < 6; round++) {
        const leaves = state.getLeafNodes();
        const candidates = classifySplitCandidates(
            makeClassifyParams(leaves, GOLD_RADIUS, { cameraDistance: GOLD_RADIUS * 1.05 })
        );
        state.splitByPriority(
            candidates.map((c) => c.nodeId),
            candidates.length
        );
    }

    return state;
}

describe('CBT golden master', () => {
    it('produces a stable tree topology', () => {
        const leaves = runScenario().getLeafNodes();
        expect(leaves.length).toBeGreaterThan(8);
        expect(topologyHash(leaves)).toMatchSnapshot();
    });

    it('produces stable emitted geometry', () => {
        const leaves = runScenario().getLeafNodes();
        expect(meshHash(leaves)).toMatchSnapshot();
    });

    it('is reproducible across runs', () => {
        const a = runScenario().getLeafNodes();
        const b = runScenario().getLeafNodes();
        expect(topologyHash(a)).toBe(topologyHash(b));
        expect(meshHash(a)).toBe(meshHash(b));
    });
});
