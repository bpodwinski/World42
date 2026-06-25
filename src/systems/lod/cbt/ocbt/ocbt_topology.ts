/**
 * OCBT topology CPU mirror — the sequential oracle for the bisector pool: octahedron
 * seed, forced-diamond conforming split, conservative diamond merge, explicit
 * neighbor maintenance. This ports the PROVEN topology of `cbt_state.ts` (which
 * already passes World42's 0-T-junction conformity tests) into the OCBT
 * representation, adding a per-slot **heapID** so the triangulation is decoded
 * vert-free via `ocbt_eval_leb` (and stored as u64 on the GPU for depth ~60).
 *
 * Why this is the oracle and not the GPU code: the GPU runs the reference's CONCURRENT
 * batch engine (4 split patterns + atomic reservation, `update_utilities.hlsl`).
 * Sequentially, every split is a single CENTER split and the forced-diamond recursion
 * handles conformity, producing an identically-conformant mesh — far simpler and
 * exhaustively checkable in Node. The GPU<->mirror cross-check (Phase 1c) compares
 * INVARIANTS (live heapID set, neighbor symmetry, 0 T-junction), not pool indices,
 * which differ by allocation order.
 *
 * Neighbor convention (from cbt_state.ts): neighbors = [BASE, LEFT, RIGHT] where BASE
 * is the hypotenuse / split-edge twin (the reference's "twin") and LEFT/RIGHT are the
 * two leg neighbors (the reference's Next/Prev). Geometry is the REFERENCE convention:
 * every node's corners are the closed-form decode `ocbtCorners(heapID)` (planar matrix,
 * projected once to the unit sphere) — no recursive slerp, no separate legacy decoder.
 */
import { ocbtCorners } from './ocbt_eval_leb';

// Root neighbours [base, left, right] across edges (L-R),(apex-L),(apex-R), in the
// REFERENCE convention (mirror of ocbt_engine_buffers ROOT_NEIGHBORS_W42). Top faces
// 0..3 have left/right swapped vs the legacy seed — consistent with GPU_FACE_CORNERS,
// whose top faces are also l/r-swapped — so the stored geometry (ocbtCorners) and the
// leg-neighbour pointers agree. Each node's geometry is decoded from its heap id.
const ROOT_NEIGHBORS: ReadonlyArray<readonly [number, number, number]> = [
    [4, 1, 3],
    [5, 2, 0],
    [6, 3, 1],
    [7, 0, 2],
    [0, 7, 5],
    [1, 4, 6],
    [2, 5, 7],
    [3, 6, 4]
];

const BASE = 0;
const LEFT = 1;
const RIGHT = 2;

const INITIAL_CAPACITY = 4096;

/** A live leaf bisector snapshot for tests/consumers. */
export interface BisectorView {
    slot: number;
    heapID: number;
    depth: number;
    neighbors: [number, number, number];
    /** Corner directions on the unit sphere: apex, left, right. */
    a: [number, number, number];
    l: [number, number, number];
    r: [number, number, number];
}

export class OcbtTopology {
    private cap = 0;
    private verts!: Float64Array; // cap*9 — apex(0-2) left(3-5) right(6-8), unit sphere
    private heapID!: Float64Array; // cap — LEB heap id (exact int < 2^53)
    private level!: Uint8Array;
    private parent!: Int32Array;
    private child0!: Int32Array;
    private child1!: Int32Array;
    private neighbors!: Int32Array; // cap*3 — [base,left,right], -1 = none
    private alive!: Uint32Array;
    private leafBits!: Uint32Array;
    private freeStack!: Int32Array;
    private freeTop = 0;
    private nextFresh = 0;
    private _leafCount = 0;

    constructor(readonly maxDepth: number) {
        this.allocArrays(INITIAL_CAPACITY);
        for (let i = 0; i < 8; i++) {
            const slot = this.allocSlot(); // roots get slots 0..7 in order
            this.level[slot] = 0;
            this.heapID[slot] = 8 + i; // face i -> heap id 8+i (depth 3)
            this.parent[slot] = -1;
            this.child0[slot] = -1;
            this.child1[slot] = -1;
            this.writeFromHeap(slot, 8 + i); // geometry = ocbtCorners(8+i)
            this.setBit(this.leafBits, slot);
            this._leafCount++;
        }
        for (let i = 0; i < ROOT_NEIGHBORS.length; i++) {
            const [b, l, r] = ROOT_NEIGHBORS[i];
            this.neighbors[i * 3 + BASE] = b;
            this.neighbors[i * 3 + LEFT] = l;
            this.neighbors[i * 3 + RIGHT] = r;
        }
    }

    get leafCount(): number {
        return this._leafCount;
    }

    /** Highest slot index ever allocated (exclusive upper bound for slot scans/tests). */
    get slotCount(): number {
        return this.nextFresh;
    }

    /** Snapshot of every live leaf bisector (for tests/consumers). */
    leaves(): BisectorView[] {
        const out: BisectorView[] = [];
        for (let slot = 0; slot < this.nextFresh; slot++) {
            if (!this.testBit(this.alive, slot)) continue;
            if (!this.testBit(this.leafBits, slot)) continue;
            const o = slot * 9;
            const v = this.verts;
            const n = slot * 3;
            out.push({
                slot,
                heapID: this.heapID[slot],
                depth: this.level[slot] + 3,
                neighbors: [
                    this.neighbors[n + BASE],
                    this.neighbors[n + LEFT],
                    this.neighbors[n + RIGHT]
                ],
                a: [v[o], v[o + 1], v[o + 2]],
                l: [v[o + 3], v[o + 4], v[o + 5]],
                r: [v[o + 6], v[o + 7], v[o + 8]]
            });
        }
        return out;
    }

    /** Split the given leaf slots (forced-diamond); returns how many splits happened. */
    splitSlots(slots: ReadonlyArray<number>, maxSplits = Infinity): number {
        let count = 0;
        for (const s of slots) {
            if (count >= maxSplits) break;
            if (this.requestSplit(s)) count++;
        }
        return count;
    }

    /** Merge the given internal (parent) slots (conservative diamond collapse). */
    mergeSlots(parentSlots: ReadonlyArray<number>, maxMerges = Infinity): number {
        let count = 0;
        for (const s of parentSlots) {
            if (count >= maxMerges) break;
            if (this.merge(s)) count++;
        }
        return count;
    }

    /**
     * Coarsen to a fixpoint: repeatedly conservative-merge every internal node whose
     * `wantsMerge(heapID, depth)` holds (heapID/depth of the internal node, i.e. the
     * would-be coarse leaf). Out-of-order attempts that violate conformity are refused
     * by {@link merge} and retried next pass, so this converges to the conforming
     * coarse closure. Used by the GPU merge cross-check.
     */
    coarsenByPredicate(wantsMerge: (heapID: number, depth: number) => boolean): void {
        for (let pass = 0; pass < 100000; pass++) {
            let merged = 0;
            for (let slot = 0; slot < this.nextFresh; slot++) {
                if (!this.testBit(this.alive, slot)) continue;
                if (this.testBit(this.leafBits, slot)) continue; // internal nodes only
                if (wantsMerge(this.heapID[slot], this.level[slot] + 3)) {
                    if (this.merge(slot)) merged++;
                }
            }
            if (merged === 0) break;
        }
    }

    requestSplit(slot: number): boolean {
        if (slot < 0 || slot >= this.nextFresh) return false;
        if (!this.testBit(this.alive, slot)) return false;
        if (!this.testBit(this.leafBits, slot)) return false;
        if (this.level[slot] >= this.maxDepth) return false;
        this.forceSplit(slot);
        return true;
    }

    // --- pool internals -----------------------------------------------------

    private allocArrays(cap: number): void {
        const words = Math.ceil(cap / 32);
        this.verts = new Float64Array(cap * 9);
        this.heapID = new Float64Array(cap);
        this.level = new Uint8Array(cap);
        this.parent = new Int32Array(cap).fill(-1);
        this.child0 = new Int32Array(cap).fill(-1);
        this.child1 = new Int32Array(cap).fill(-1);
        this.neighbors = new Int32Array(cap * 3).fill(-1);
        this.alive = new Uint32Array(words);
        this.leafBits = new Uint32Array(words);
        this.freeStack = new Int32Array(cap);
        this.cap = cap;
    }

    private grow(): void {
        const newCap = this.cap * 2;
        const words = Math.ceil(newCap / 32);
        const verts = new Float64Array(newCap * 9);
        verts.set(this.verts);
        const heapID = new Float64Array(newCap);
        heapID.set(this.heapID);
        const level = new Uint8Array(newCap);
        level.set(this.level);
        const parent = new Int32Array(newCap).fill(-1);
        parent.set(this.parent);
        const child0 = new Int32Array(newCap).fill(-1);
        child0.set(this.child0);
        const child1 = new Int32Array(newCap).fill(-1);
        child1.set(this.child1);
        const neighbors = new Int32Array(newCap * 3).fill(-1);
        neighbors.set(this.neighbors);
        const alive = new Uint32Array(words);
        alive.set(this.alive);
        const leafBits = new Uint32Array(words);
        leafBits.set(this.leafBits);
        const freeStack = new Int32Array(newCap);
        freeStack.set(this.freeStack);
        this.verts = verts;
        this.heapID = heapID;
        this.level = level;
        this.parent = parent;
        this.child0 = child0;
        this.child1 = child1;
        this.neighbors = neighbors;
        this.alive = alive;
        this.leafBits = leafBits;
        this.freeStack = freeStack;
        this.cap = newCap;
    }

    private testBit(field: Uint32Array, i: number): boolean {
        return ((field[i >>> 5] >>> (i & 31)) & 1) === 1;
    }
    private setBit(field: Uint32Array, i: number): void {
        field[i >>> 5] |= 1 << (i & 31);
    }
    private clearBit(field: Uint32Array, i: number): void {
        field[i >>> 5] &= ~(1 << (i & 31));
    }

    private allocSlot(): number {
        let slot: number;
        if (this.freeTop > 0) {
            slot = this.freeStack[--this.freeTop];
        } else {
            if (this.nextFresh >= this.cap) this.grow();
            slot = this.nextFresh++;
        }
        this.setBit(this.alive, slot);
        return slot;
    }

    private freeSlot(slot: number): void {
        this.clearBit(this.alive, slot);
        this.clearBit(this.leafBits, slot);
        this.heapID[slot] = 0;
        this.neighbors[slot * 3 + BASE] = -1;
        this.neighbors[slot * 3 + LEFT] = -1;
        this.neighbors[slot * 3 + RIGHT] = -1;
        this.freeStack[this.freeTop++] = slot;
    }

    private nb(slot: number, edge: number): number {
        return this.neighbors[slot * 3 + edge];
    }
    private setNb(slot: number, edge: number, value: number): void {
        if (slot >= 0) this.neighbors[slot * 3 + edge] = value;
    }
    private replaceNeighbor(x: number, oldT: number, newT: number): void {
        if (x < 0) return;
        const o = x * 3;
        if (this.neighbors[o + BASE] === oldT) this.neighbors[o + BASE] = newT;
        if (this.neighbors[o + LEFT] === oldT) this.neighbors[o + LEFT] = newT;
        if (this.neighbors[o + RIGHT] === oldT) this.neighbors[o + RIGHT] = newT;
    }

    /**
     * Write a slot's geometry from the closed-form decode of its heap id (reference
     * convention). `ocbtCorners` returns (v0,v1,v2) = (right, apex, left); store as the
     * node's (apex, left, right) = (v1, v2, v0).
     */
    private writeFromHeap(slot: number, heapID: number): void {
        const c = ocbtCorners(heapID);
        this.writeVerts(slot, c[1], c[2], c[0]);
    }

    private writeVerts(
        slot: number,
        a: readonly [number, number, number],
        l: readonly [number, number, number],
        r: readonly [number, number, number]
    ): void {
        const o = slot * 9;
        const v = this.verts;
        v[o] = a[0];
        v[o + 1] = a[1];
        v[o + 2] = a[2];
        v[o + 3] = l[0];
        v[o + 4] = l[1];
        v[o + 5] = l[2];
        v[o + 6] = r[0];
        v[o + 7] = r[1];
        v[o + 8] = r[2];
    }

    // --- refinement (ROAM forced-diamond split) -----------------------------

    /**
     * Conforming split via Rivara's Longest-Edge Propagation Path (LEPP). Watertight +
     * symmetric for ANY refinement (single-region, multi-region, arbitrary, across the
     * 12 octahedron seams) — the general fix over cbt_state.ts's base-only forcing,
     * which only worked for single coherent regions (it forced the base ONE level with
     * no level check, stranding T-junctions where ≥2-level differences met).
     *
     * Algorithm: to bisect `target`, repeatedly walk from it along the longest-edge
     * (BASE) neighbour to the LEPP terminal — a pair of same-level triangles that
     * share their mutual longest edge (a diamond), or a boundary — and bisect that
     * terminal diamond. Each terminal bisection shortens the path; iterate until the
     * target itself becomes the terminal and is bisected. Rivara proves this
     * terminates and yields a conforming (crack-free) mesh. Hitting maxDepth at a
     * terminal refuses the whole split (no partial diamond → no T-junction), which is
     * the correct depth-cap behaviour.
     */
    private forceSplit(t: number): void {
        if (!this.testBit(this.leafBits, t)) return;
        if (this.level[t] >= this.maxDepth) return;

        // Longest-edge propagation as a DEPTH fixpoint: while the split-edge (BASE)
        // neighbour is strictly COARSER, recursively split it first (which forces ITS
        // own base chain, transitively up the longest-edge path to the equatorial base
        // diamond — across the octahedron seams too, since BASE stores the seam twin).
        // Refetch each pass: subdivide() repoints t's BASE to the correct child. The
        // DEPTH test (not the old topology test nb(tb,BASE)!=t) is what fixes the
        // multi-region / >=2-level / cross-face T-junctions base-only forcing stranded.
        let tb = this.nb(t, BASE);
        let guard = 0;
        while (tb !== -1 && this.level[tb] < this.level[t]) {
            this.forceSplit(tb);
            // Forcing a coarser twin can bisect the diamond it shares with t, splitting
            // t itself (as the partner). If so, t is already done — re-splitting it would
            // duplicate children (non-manifold). Bail out.
            if (!this.testBit(this.leafBits, t)) return;
            tb = this.nb(t, BASE);
            if (++guard > 8 * this.maxDepth) break; // safety (cannot happen)
        }
        // tb is now -1 (boundary) or a same-depth leaf diamond partner — bisect together.
        this.bisectDiamond(t);
    }

    /**
     * Bisect a LEPP-terminal diamond: `t` and its BASE neighbour (a same-level
     * reciprocal leaf, or -1 at a boundary). Both halves split together and their
     * children are cross-linked across the shared hypotenuse so the mesh stays
     * watertight. (This is the old base-only forceSplit body, minus the pre-forcing —
     * the LEPP walk in {@link forceSplit} guarantees `t`'s base is a valid terminal.)
     */
    private bisectDiamond(t: number): void {
        const tb = this.nb(t, BASE);

        // t's left base vertex BEFORE subdividing (used to orient the shared hypotenuse).
        const tL = t * 9 + 3;
        const tLx = this.verts[tL];
        const tLy = this.verts[tL + 1];
        const tLz = this.verts[tL + 2];

        const [t0, t1] = this.subdivide(t);
        if (tb === -1) {
            this.setNb(t0, RIGHT, -1);
            this.setNb(t1, LEFT, -1);
            return;
        }
        // Tolerance compare: planar corners shared across distinct triangles agree to
        // ~f64 ULP, not bit-exact (each comes from an independent ocbtCorners decode).
        const bL = tb * 9 + 3;
        const tbLeftIsTL =
            Math.abs(this.verts[bL] - tLx) < 1e-9 &&
            Math.abs(this.verts[bL + 1] - tLy) < 1e-9 &&
            Math.abs(this.verts[bL + 2] - tLz) < 1e-9;

        const [tb0, tb1] = this.subdivide(tb);
        if (tbLeftIsTL) {
            this.setNb(t0, RIGHT, tb0);
            this.setNb(tb0, RIGHT, t0);
            this.setNb(t1, LEFT, tb1);
            this.setNb(tb1, LEFT, t1);
        } else {
            this.setNb(t0, RIGHT, tb1);
            this.setNb(tb1, LEFT, t0);
            this.setNb(t1, LEFT, tb0);
            this.setNb(tb0, RIGHT, t1);
        }
    }

    /**
     * Split bintree triangle t into its two LEB children. In the REFERENCE convention
     * the child labeling is the PURE INTEGER rule: t0 keeps the parent's {apex,left}
     * (bit0 -> heap 2h), t1 keeps {apex,right} (bit1 -> heap 2h+1) — no geometry match
     * needed (the "flip per level" was an artefact of the legacy decoder). Geometry is
     * the closed-form ocbtCorners(childHeap), planar and projected once, NOT a slerp
     * midpoint. t0 inherits the parent's LEFT leg as its base, t1 the RIGHT leg.
     */
    private subdivide(t: number): [number, number] {
        // Capture parent state BEFORE allocating: allocSlot() can grow() and REPLACE the
        // typed arrays, so every index access after the alloc must go through this.X[...].
        const lvl = this.level[t] + 1;
        const h = this.heapID[t];
        const xL = this.nb(t, LEFT);
        const xR = this.nb(t, RIGHT);

        const t0 = this.allocSlot();
        const t1 = this.allocSlot();

        // t0 = (apex=VC, left=parentApex, right=parentLeft) = ocbtCorners(2h).
        this.heapID[t0] = 2 * h;
        this.level[t0] = lvl;
        this.parent[t0] = t;
        this.child0[t0] = -1;
        this.child1[t0] = -1;
        this.writeFromHeap(t0, 2 * h);
        this.setBit(this.leafBits, t0);

        // t1 = (apex=VC, left=parentRight, right=parentApex) = ocbtCorners(2h+1).
        this.heapID[t1] = 2 * h + 1;
        this.level[t1] = lvl;
        this.parent[t1] = t;
        this.child0[t1] = -1;
        this.child1[t1] = -1;
        this.writeFromHeap(t1, 2 * h + 1);
        this.setBit(this.leafBits, t1);

        // Internal shared edge (VC,A): t0.LEFT <-> t1.RIGHT.
        this.setNb(t0, LEFT, t1);
        this.setNb(t1, RIGHT, t0);

        // Child base = parent leg; redirect the leg neighbour to point at the child.
        this.setNb(t0, BASE, xL);
        this.replaceNeighbor(xL, t, t0);
        this.setNb(t1, BASE, xR);
        this.replaceNeighbor(xR, t, t1);

        this.child0[t] = t0;
        this.child1[t] = t1;
        this.clearBit(this.leafBits, t);
        this._leafCount += 1;

        return [t0, t1];
    }

    // --- decimation (conservative diamond collapse) -------------------------

    merge(parentSlot: number): boolean {
        if (parentSlot < 0 || parentSlot >= this.nextFresh) return false;
        if (!this.testBit(this.alive, parentSlot)) return false;
        if (this.testBit(this.leafBits, parentSlot)) return false;

        const t0 = this.child0[parentSlot];
        const t1 = this.child1[parentSlot];
        if (t0 === -1 || t1 === -1) return false;
        if (!this.testBit(this.leafBits, t0) || !this.testBit(this.leafBits, t1)) return false;

        const tb1 = this.nb(t0, RIGHT);
        if (tb1 === -1) {
            // Boundary collapse: still refuse if a child has a finer neighbour to strand.
            if (this.hasFinerNeighbor(t0) || this.hasFinerNeighbor(t1)) return false;
            this.collapseOne(parentSlot, t0, t1);
            return true;
        }
        const tb = this.parent[tb1];
        if (tb < 0 || this.testBit(this.leafBits, tb)) return false;
        // Collapse ONLY a genuine same-level reciprocal diamond. LEPP forces conformity
        // along the BASE chain only, so a child's leg (RIGHT/LEFT) neighbour may legally
        // be FINER — then t0.RIGHT points at a finer DESCENDANT of the true partner and
        // tb = parent[tb1] is the wrong (level-mismatched) node. Collapsing it corrupts
        // the mesh (T-junctions + dangling refs into freed slots). Require same level and
        // reciprocity via the other hypotenuse half (t1.LEFT must also descend from tb).
        if (this.level[tb] !== this.level[parentSlot]) return false;
        const t1L = this.nb(t1, LEFT);
        if (t1L < 0 || this.parent[t1L] !== tb) return false;
        const tb0 = this.child0[tb];
        const tb1c = this.child1[tb];
        if (tb0 === -1 || tb1c === -1) return false;
        if (!this.testBit(this.leafBits, tb0) || !this.testBit(this.leafBits, tb1c)) return false;
        // Conservative decimation: refuse if ANY of the four collapse-children has a
        // strictly finer neighbour. Restoring the coarse parent edge over a refined
        // neighbour would crack the mesh (and the finer neighbour would dangle into the
        // freed child slot). This is the dual of forceSplit's conformity guard.
        if (
            this.hasFinerNeighbor(t0) ||
            this.hasFinerNeighbor(t1) ||
            this.hasFinerNeighbor(tb0) ||
            this.hasFinerNeighbor(tb1c)
        ) {
            return false;
        }

        this.collapseOne(parentSlot, t0, t1);
        this.collapseOne(tb, tb0, tb1c);
        this.setNb(parentSlot, BASE, tb);
        this.setNb(tb, BASE, parentSlot);
        return true;
    }

    /** True if any of slot `c`'s three neighbours is strictly finer (deeper) than `c`. */
    private hasFinerNeighbor(c: number): boolean {
        const lc = this.level[c];
        const o = c * 3;
        for (let e = 0; e < 3; e++) {
            const n = this.neighbors[o + e];
            if (n >= 0 && this.level[n] > lc) return true;
        }
        return false;
    }

    private collapseOne(t: number, t0: number, t1: number): void {
        const xL = this.nb(t0, BASE);
        const xR = this.nb(t1, BASE);
        this.replaceNeighbor(xL, t0, t);
        this.replaceNeighbor(xR, t1, t);
        this.setNb(t, LEFT, xL);
        this.setNb(t, RIGHT, xR);
        this.freeSlot(t0);
        this.freeSlot(t1);
        this.child0[t] = -1;
        this.child1[t] = -1;
        this.setBit(this.leafBits, t);
        this._leafCount -= 1;
    }
}
