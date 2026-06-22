/**
 * CPU-side mirror of the WGSL CBT heap (Dupuy 2021), used to (a) build the
 * initial bit-packed buffer uploaded to the GPU and (b) verify GPU readback in
 * tests. The bit layout MUST match cbt_heap_rw.wgsl exactly:
 *   - node (id, depth) value occupies (D - depth + 1) bits at
 *     bitID = 2^(depth+1) + id * (D - depth + 1);
 *   - depth-D level is the 1-bit-per-node leaf bitfield;
 *   - a subdivision leaf at depth d sets one bit (its leftmost depth-D
 *     descendant); an internal node's value == number of leaves in its subtree.
 * Validated bit-for-bit against the reference model and the GPU.
 */

/** Number of u32 words needed for a CBT heap of depth `maxDepth` (+1 guard word). */
export function cbtHeapU32Count(maxDepth: number): number {
    // Highest bit used is at the deepest level: 2^(D+2). Round up to words, +1 guard.
    return Math.ceil(Math.pow(2, maxDepth + 2) / 32) + 1;
}

/** Byte size of a CBT heap StorageBuffer for depth `maxDepth`. */
export function cbtHeapByteSize(maxDepth: number): number {
    return cbtHeapU32Count(maxDepth) * 4;
}

/**
 * Bit-packed CBT heap on the CPU. Pure integer math (mirrors the WGSL core), so
 * the produced buffer is byte-identical to what the GPU would build/read.
 */
export class CbtCpuHeap {
    readonly maxDepth: number;
    readonly heap: Uint32Array;

    constructor(maxDepth: number, heap?: Uint32Array) {
        this.maxDepth = maxDepth;
        this.heap = heap ?? new Uint32Array(cbtHeapU32Count(maxDepth));
    }

    private bitSize(depth: number): number {
        return this.maxDepth - depth + 1;
    }

    private bitID(id: number, depth: number): number {
        // 2^(depth+1) + id * bitSize. Stays < 2^31 for D <= 28.
        return Math.pow(2, depth + 1) + id * this.bitSize(depth);
    }

    private static mask(n: number): number {
        return n >= 32 ? 0xffffffff : (((1 << n) >>> 0) - 1) >>> 0;
    }

    private readBits(off: number, cnt: number): number {
        const w = off >>> 5;
        const b = off & 31;
        const first = Math.min(cnt, 32 - b);
        let r = (this.heap[w] >>> b) & CbtCpuHeap.mask(first);
        if (first < cnt) {
            const sec = cnt - first;
            r = (r | ((this.heap[w + 1] & CbtCpuHeap.mask(sec)) << first)) >>> 0;
        }
        return r >>> 0;
    }

    private writeBits(off: number, cnt: number, val: number): void {
        const w = off >>> 5;
        const b = off & 31;
        const first = Math.min(cnt, 32 - b);
        const m1 = (CbtCpuHeap.mask(first) << b) >>> 0;
        this.heap[w] = ((this.heap[w] & ~m1) | (((val << b) >>> 0) & m1)) >>> 0;
        if (first < cnt) {
            const sec = cnt - first;
            const m2 = CbtCpuHeap.mask(sec);
            this.heap[w + 1] = ((this.heap[w + 1] & ~m2) | ((val >>> first) & m2)) >>> 0;
        }
    }

    heapRead(id: number, depth: number): number {
        return this.readBits(this.bitID(id, depth), this.bitSize(depth));
    }

    heapWrite(id: number, depth: number, value: number): void {
        this.writeBits(this.bitID(id, depth), this.bitSize(depth), value >>> 0);
    }

    /** Bitfield index (0 .. 2^D-1) of node's leftmost depth-D descendant. */
    bfIndex(id: number, depth: number): number {
        return (id << (this.maxDepth - depth)) - Math.pow(2, this.maxDepth);
    }

    setBit(bitIndex: number, value: number): void {
        this.heapWrite(Math.pow(2, this.maxDepth) + bitIndex, this.maxDepth, value ? 1 : 0);
    }

    getBit(bitIndex: number): number {
        return this.heapRead(Math.pow(2, this.maxDepth) + bitIndex, this.maxDepth);
    }

    nodeCount(): number {
        return this.heapRead(1, 0);
    }

    /** Full sum-reduction from depth D-1 up to the root. */
    sumReduce(): void {
        for (let depth = this.maxDepth - 1; depth >= 0; depth--) {
            const start = Math.pow(2, depth);
            const end = Math.pow(2, depth + 1);
            for (let id = start; id < end; id++) {
                const x0 = this.heapRead(id * 2, depth + 1);
                const x1 = this.heapRead(id * 2 + 1, depth + 1);
                this.heapWrite(id, depth, x0 + x1);
            }
        }
    }

    /** Mark every node at depth `d0` as a leaf (one bit each). */
    seedLevel(d0: number): void {
        const start = Math.pow(2, d0);
        const end = Math.pow(2, d0 + 1);
        for (let id = start; id < end; id++) {
            this.setBit(this.bfIndex(id, d0), 1);
        }
    }

    /** (heapId, depth) of the handle-th subdivision leaf. */
    decode(handle: number): { id: number; depth: number } {
        let id = 1;
        let depth = 0;
        let h = handle;
        while (this.heapRead(id, depth) > 1) {
            const lid = id * 2;
            const ldep = depth + 1;
            const lv = this.heapRead(lid, ldep);
            if (h < lv) {
                id = lid;
                depth = ldep;
            } else {
                h -= lv;
                id = lid + 1;
                depth = ldep;
            }
        }
        return { id, depth };
    }
}
