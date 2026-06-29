import { Vector3 } from '@babylonjs/core';

export type CbtNode = {
    id: number;
    level: number;
    parentId: number | null;
    leftId: number | null;
    rightId: number | null;
    /** apex vertex (bintree convention). */
    v0: Vector3;
    /** left base vertex. */
    v1: Vector3;
    /** right base vertex. */
    v2: Vector3;
    isLeaf: boolean;
};

// Octahedron vertices.
const VX = [
    new Vector3(1, 0, 0), // 0 +x
    new Vector3(-1, 0, 0), // 1 -x
    new Vector3(0, 1, 0), // 2 +y
    new Vector3(0, -1, 0), // 3 -y
    new Vector3(0, 0, 1), // 4 +z
    new Vector3(0, 0, -1), // 5 -z
] as const;

/**
 * Root bintree triangles in (apex, left, right) order, with the split edge being
 * the hypotenuse (left–right). Apex is a pole (+y / −y); the hypotenuse is an
 * equatorial edge. Paired into 4 base-edge diamonds so every root's base
 * neighbour shares its full hypotenuse: {0,4} {1,5} {2,6} {3,7}.
 */
const ROOT_ALR: ReadonlyArray<readonly [number, number, number]> = [
    [2, 0, 4], // 0
    [2, 4, 1], // 1
    [2, 1, 5], // 2
    [2, 5, 0], // 3
    [3, 0, 4], // 4
    [3, 4, 1], // 5
    [3, 1, 5], // 6
    [3, 5, 0], // 7
];

// Root neighbours: [base, left, right] across edges (L–R), (apex–L), (apex–R).
// Verified symmetric (see plan): base pairs are the 4 diamonds.
const ROOT_NEIGHBORS: ReadonlyArray<readonly [number, number, number]> = [
    [4, 3, 1], // 0
    [5, 0, 2], // 1
    [6, 1, 3], // 2
    [7, 2, 0], // 3
    [0, 7, 5], // 4
    [1, 4, 6], // 5
    [2, 5, 7], // 6
    [3, 6, 4], // 7
];

// Edge slot indices into the neighbours triple.
const BASE = 0;
const LEFT = 1;
const RIGHT = 2;

function midpointOnSphere(ax: number, ay: number, az: number, bx: number, by: number, bz: number, radius: number, out: Vector3): void {
    let mx = (ax + bx) * 0.5;
    let my = (ay + by) * 0.5;
    let mz = (az + bz) * 0.5;
    let len = Math.sqrt(mx * mx + my * my + mz * mz);
    if (len < 1e-12) {
        // Antipodal fallback: keep a stable axis.
        mx = ax;
        my = ay;
        mz = az;
        len = Math.sqrt(mx * mx + my * my + mz * mz);
    }
    const s = radius / len;
    out.set(mx * s, my * s, mz * s);
}

const INITIAL_CAPACITY = 4096;

/**
 * Concurrent Binary Tree over a quad-sphere, stored in a typed-array pool
 * (paper roadmap P1+P2+P4). Each node is a ROAM binary triangle in
 * (apex, left, right) order; the split edge is always the hypotenuse, so the
 * base neighbour is well defined. Refinement uses the ROAM forced-diamond split
 * (Rivara/Duchaineau compatibility chain) which keeps the mesh **watertight**
 * (no T-junction cracks) and restricted (edge-adjacent triangles differ by ≤1
 * level). Decimation is conservative: a diamond collapses only when all four of
 * its triangles are leaves.
 */
export class CbtState {
    private cap = 0;
    private verts!: Float64Array; // cap*9 — apex(0-2) left(3-5) right(6-8)
    private level!: Uint8Array;
    private parent!: Int32Array;
    private child0!: Int32Array; // left child (-1 = leaf)
    private child1!: Int32Array; // right child
    private neighbors!: Int32Array; // cap*3 — [base,left,right], -1 = none
    private alive!: Uint32Array;
    private leafBits!: Uint32Array;
    private freeStack!: Int32Array;
    private freeTop = 0;
    private nextFresh = 0;
    private _leafCount = 0;

    private leafCacheDirty = true;
    private leafCache: CbtNode[] = [];
    private nodePool: CbtNode[] = [];

    private readonly tmpMid = new Vector3();

    constructor(
        readonly radiusSim: number,
        readonly maxDepth: number
    ) {
        this.allocArrays(INITIAL_CAPACITY);
        for (let i = 0; i < ROOT_ALR.length; i++) {
            const [a, l, r] = ROOT_ALR[i];
            const slot = this.allocSlot(); // roots get slots 0..7 in order
            this.level[slot] = 0;
            this.parent[slot] = -1;
            this.child0[slot] = -1;
            this.child1[slot] = -1;
            this.writeVertsScaled(slot, VX[a], VX[l], VX[r], radiusSim);
            this.setBit(this.leafBits, slot);
            this._leafCount++;
        }
        for (let i = 0; i < ROOT_NEIGHBORS.length; i++) {
            const [b, l, r] = ROOT_NEIGHBORS[i];
            this.neighbors[i * 3 + BASE] = b;
            this.neighbors[i * 3 + LEFT] = l;
            this.neighbors[i * 3 + RIGHT] = r;
        }
        this.leafCacheDirty = true;
    }

    get leafCount(): number {
        return this._leafCount;
    }

    getLeafNodes(): CbtNode[] {
        if (!this.leafCacheDirty) return this.leafCache;
        const out: CbtNode[] = [];
        for (let slot = 0; slot < this.nextFresh; slot++) {
            if (!this.testBit(this.alive, slot)) continue;
            if (!this.testBit(this.leafBits, slot)) continue;
            out.push(this.materialize(slot));
        }
        this.leafCache = out;
        this.leafCacheDirty = false;
        return out;
    }

    splitByPriority(nodeIds: ReadonlyArray<number>, maxSplits: number): number {
        let splitCount = 0;
        for (const id of nodeIds) {
            if (splitCount >= maxSplits) break;
            if (this.requestSplit(id)) splitCount++;
        }
        return splitCount;
    }

    mergeByParentPriority(parentIds: ReadonlyArray<number>, maxMerges: number): number {
        let mergeCount = 0;
        for (const id of parentIds) {
            if (mergeCount >= maxMerges) break;
            if (this.merge(id)) mergeCount++;
        }
        return mergeCount;
    }

    // --- pool internals -----------------------------------------------------

    private allocArrays(cap: number): void {
        const words = Math.ceil(cap / 32);
        this.verts = new Float64Array(cap * 9);
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
    /** Redirect x's neighbour pointer that referenced `oldT` to `newT`. */
    private replaceNeighbor(x: number, oldT: number, newT: number): void {
        if (x < 0) return;
        const o = x * 3;
        if (this.neighbors[o + BASE] === oldT) this.neighbors[o + BASE] = newT;
        if (this.neighbors[o + LEFT] === oldT) this.neighbors[o + LEFT] = newT;
        if (this.neighbors[o + RIGHT] === oldT) this.neighbors[o + RIGHT] = newT;
    }

    private writeVertsScaled(slot: number, a: Vector3, l: Vector3, r: Vector3, radius: number): void {
        const o = slot * 9;
        const v = this.verts;
        v[o] = a.x * radius;
        v[o + 1] = a.y * radius;
        v[o + 2] = a.z * radius;
        v[o + 3] = l.x * radius;
        v[o + 4] = l.y * radius;
        v[o + 5] = l.z * radius;
        v[o + 6] = r.x * radius;
        v[o + 7] = r.y * radius;
        v[o + 8] = r.z * radius;
    }

    private materialize(slot: number): CbtNode {
        const o = slot * 9;
        const v = this.verts;
        const c0 = this.child0[slot];
        const c1 = this.child1[slot];
        const p = this.parent[slot];
        const parentId = p === -1 ? null : p;
        const leftId = c0 === -1 ? null : c0;
        const rightId = c1 === -1 ? null : c1;
        const isLeaf = this.testBit(this.leafBits, slot);

        let node = this.nodePool[slot];
        if (!node) {
            node = {
                id: slot,
                level: this.level[slot],
                parentId,
                leftId,
                rightId,
                v0: new Vector3(v[o], v[o + 1], v[o + 2]),
                v1: new Vector3(v[o + 3], v[o + 4], v[o + 5]),
                v2: new Vector3(v[o + 6], v[o + 7], v[o + 8]),
                isLeaf,
            };
            this.nodePool[slot] = node;
            return node;
        }
        node.level = this.level[slot];
        node.parentId = parentId;
        node.leftId = leftId;
        node.rightId = rightId;
        node.v0.copyFromFloats(v[o], v[o + 1], v[o + 2]);
        node.v1.copyFromFloats(v[o + 3], v[o + 4], v[o + 5]);
        node.v2.copyFromFloats(v[o + 6], v[o + 7], v[o + 8]);
        node.isLeaf = isLeaf;
        return node;
    }

    // --- refinement (ROAM forced-diamond split) -----------------------------

    private requestSplit(slot: number): boolean {
        if (slot < 0 || slot >= this.nextFresh) return false;
        if (!this.testBit(this.alive, slot)) return false;
        if (!this.testBit(this.leafBits, slot)) return false;
        if (this.level[slot] >= this.maxDepth) return false;
        this.forceSplit(slot);
        this.leafCacheDirty = true;
        return true;
    }

    private forceSplit(t: number): void {
        if (!this.testBit(this.leafBits, t)) return; // already split
        if (this.level[t] >= this.maxDepth) return;

        let tb = this.nb(t, BASE);
        if (tb !== -1 && this.nb(tb, BASE) !== t) {
            // Base neighbour is coarser / not a diamond partner — split it first.
            this.forceSplit(tb);
            tb = this.nb(t, BASE); // refetch: now a same-level child
        }

        // Read t's left base vertex BEFORE subdividing (verts unchanged by subdivide).
        const tL = t * 9 + 3;
        const tLx = this.verts[tL], tLy = this.verts[tL + 1], tLz = this.verts[tL + 2];

        const [t0, t1] = this.subdivide(t);
        if (tb === -1) {
            this.setNb(t0, RIGHT, -1);
            this.setNb(t1, LEFT, -1);
            return;
        }
        // Orientation of the shared hypotenuse: does tb.left coincide with t.left
        // or t.right? (Winding is not globally enforced, so detect per split.)
        const bL = tb * 9 + 3;
        const tbLeftIsTL =
            this.verts[bL] === tLx && this.verts[bL + 1] === tLy && this.verts[bL + 2] === tLz;

        const [tb0, tb1] = this.subdivide(tb);
        // Cross-link the four children across the two halves of the shared hypotenuse.
        // t0's outer half-edge is (VC, t.left); t1's is (VC, t.right).
        if (tbLeftIsTL) {
            // tb.left == t.left ⇒ tb0 owns (VC, t.left), tb1 owns (VC, t.right).
            this.setNb(t0, RIGHT, tb0);
            this.setNb(tb0, RIGHT, t0);
            this.setNb(t1, LEFT, tb1);
            this.setNb(tb1, LEFT, t1);
        } else {
            // tb.left == t.right ⇒ tb1 owns (VC, t.left), tb0 owns (VC, t.right).
            this.setNb(t0, RIGHT, tb1);
            this.setNb(tb1, LEFT, t0);
            this.setNb(t1, LEFT, tb0);
            this.setNb(tb0, RIGHT, t1);
        }
    }

    /**
     * Split one bintree triangle t=(A,L,R) into t0=(VC,A,L) and t1=(VC,R,A),
     * wiring the internal shared edge and the two leg (base-of-child) neighbours.
     * The cross-hypotenuse links (t0.RIGHT / t1.LEFT) are set by the caller.
     */
    private subdivide(t: number): [number, number] {
        const o = t * 9;
        const v = this.verts;
        const ax = v[o], ay = v[o + 1], az = v[o + 2];
        const lx = v[o + 3], ly = v[o + 4], lz = v[o + 5];
        const rx = v[o + 6], ry = v[o + 7], rz = v[o + 8];
        midpointOnSphere(lx, ly, lz, rx, ry, rz, this.radiusSim, this.tmpMid);
        const mx = this.tmpMid.x, my = this.tmpMid.y, mz = this.tmpMid.z;

        const lvl = this.level[t] + 1;
        const xL = this.nb(t, LEFT);
        const xR = this.nb(t, RIGHT);

        const t0 = this.allocSlot();
        const t1 = this.allocSlot();

        // Re-fetch verts AFTER allocation: allocSlot() can grow() and REPLACE this.verts,
        // so the `v` captured above is the orphaned old array. Parent verts were already
        // read into ax..rz (values) before the alloc, so only the child WRITES below must
        // target the live array. (Without this, slots past the grow boundary get written
        // to the dead array -> 0/NaN verts -> cracks.)
        const vw = this.verts;

        // t0 = (apex=VC, left=A, right=L); hypotenuse (A,L) == parent's LEFT edge.
        let p = t0 * 9;
        vw[p] = mx; vw[p + 1] = my; vw[p + 2] = mz;
        vw[p + 3] = ax; vw[p + 4] = ay; vw[p + 5] = az;
        vw[p + 6] = lx; vw[p + 7] = ly; vw[p + 8] = lz;
        this.level[t0] = lvl;
        this.parent[t0] = t;
        this.child0[t0] = -1;
        this.child1[t0] = -1;
        this.setBit(this.leafBits, t0);

        // t1 = (apex=VC, left=R, right=A); hypotenuse (R,A) == parent's RIGHT edge.
        p = t1 * 9;
        vw[p] = mx; vw[p + 1] = my; vw[p + 2] = mz;
        vw[p + 3] = rx; vw[p + 4] = ry; vw[p + 5] = rz;
        vw[p + 6] = ax; vw[p + 7] = ay; vw[p + 8] = az;
        this.level[t1] = lvl;
        this.parent[t1] = t;
        this.child0[t1] = -1;
        this.child1[t1] = -1;
        this.setBit(this.leafBits, t1);

        // Internal shared edge (VC,A): t0.LEFT ↔ t1.RIGHT.
        this.setNb(t0, LEFT, t1);
        this.setNb(t1, RIGHT, t0);

        // Child base = parent leg; redirect the leg neighbour to point at the child.
        this.setNb(t0, BASE, xL);
        this.replaceNeighbor(xL, t, t0);
        this.setNb(t1, BASE, xR);
        this.replaceNeighbor(xR, t, t1);

        // Mark t internal.
        this.child0[t] = t0;
        this.child1[t] = t1;
        this.clearBit(this.leafBits, t);
        this._leafCount += 1; // -1 parent, +2 children

        return [t0, t1];
    }

    // --- decimation (conservative diamond collapse) -------------------------

    private merge(parentSlot: number): boolean {
        if (parentSlot < 0 || parentSlot >= this.nextFresh) return false;
        if (!this.testBit(this.alive, parentSlot)) return false;
        if (this.testBit(this.leafBits, parentSlot)) return false; // already a leaf

        const t0 = this.child0[parentSlot];
        const t1 = this.child1[parentSlot];
        if (t0 === -1 || t1 === -1) return false;
        if (!this.testBit(this.leafBits, t0) || !this.testBit(this.leafBits, t1)) return false;

        // Diamond partner = parent of t0's cross neighbour (t0.RIGHT).
        const tb1 = this.nb(t0, RIGHT);
        if (tb1 === -1) {
            // Boundary collapse (no sphere case): restore t alone.
            this.collapseOne(parentSlot, t0, t1);
            this.leafCacheDirty = true;
            return true;
        }
        const tb = this.parent[tb1];
        if (tb < 0 || this.testBit(this.leafBits, tb)) return false;
        const tb0 = this.child0[tb];
        const tb1c = this.child1[tb];
        if (tb0 === -1 || tb1c === -1) return false;
        if (!this.testBit(this.leafBits, tb0) || !this.testBit(this.leafBits, tb1c)) return false;

        // Collapse both halves of the diamond.
        this.collapseOne(parentSlot, t0, t1);
        this.collapseOne(tb, tb0, tb1c);
        // Restore the base-pair link between the two coarse triangles.
        this.setNb(parentSlot, BASE, tb);
        this.setNb(tb, BASE, parentSlot);
        this.leafCacheDirty = true;
        return true;
    }

    /** Restore an internal node to a leaf, freeing its two leaf children and
     *  redirecting the children's outer (leg) neighbours back to the parent. */
    private collapseOne(t: number, t0: number, t1: number): void {
        const xL = this.nb(t0, BASE); // child t0's base == parent's LEFT leg
        const xR = this.nb(t1, BASE); // child t1's base == parent's RIGHT leg
        this.replaceNeighbor(xL, t0, t);
        this.replaceNeighbor(xR, t1, t);
        this.setNb(t, LEFT, xL);
        this.setNb(t, RIGHT, xR);

        this.freeSlot(t0);
        this.freeSlot(t1);
        this.child0[t] = -1;
        this.child1[t] = -1;
        this.setBit(this.leafBits, t);
        this._leafCount -= 1; // -2 children, +1 parent
    }
}
