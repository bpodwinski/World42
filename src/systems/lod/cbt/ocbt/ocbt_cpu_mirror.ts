/**
 * CPU mirror of the OCBT pool allocator — the golden oracle for the GPU WGSL port
 * (`ocbt_pool.wgsl`) and the test reference. Faithful to the decode/reduce
 * semantics of `references/large_cbt/shaders/shader_lib/ocbt_generic.hlsl`:
 *
 *  - `decodeBit(i)`            -> slot of the i-th ALLOCATED bit (ascending)
 *  - `decodeBitComplement(i)`  -> slot of the i-th FREE bit (ascending)
 *  - `count()`                 -> number of allocated slots (sum-tree root)
 *
 * The reference packs the sum-tree into variable-bit-width words (a GPU memory
 * optimization). The mirror uses a plain 1-indexed `Uint32Array` sum-tree of size
 * `2*capacity` (leaves at `[capacity, 2*capacity)`): byte-layout differs from the
 * GPU but the decode RESULTS are identical, which is what the GPU<->mirror
 * cross-check compares. `setBit` keeps the tree path current (O(log capacity)) so
 * decode/count are always valid; `reduce` rebuilds the whole tree from the bitfield
 * (used when seeding from an externally-filled bitfield).
 */
import {
    assertPowerOfTwo,
    bitfieldWordCount,
    log2PowerOfTwo,
} from './ocbt_pool';

export class OcbtPool {
    readonly capacity: number;
    readonly depth: number;
    /** Packed allocation bitfield: bit = 1 means the slot is allocated. */
    private readonly bits: Uint32Array;
    /** 1-indexed binary sum-tree; tree[1] = total allocated, leaves at capacity+slot. */
    private readonly tree: Uint32Array;

    constructor(capacity: number) {
        assertPowerOfTwo(capacity);
        this.capacity = capacity;
        this.depth = log2PowerOfTwo(capacity);
        this.bits = new Uint32Array(bitfieldWordCount(capacity));
        this.tree = new Uint32Array(2 * capacity);
    }

    /** Read the allocation bit of `slot` (1 = allocated). */
    getBit(slot: number): 0 | 1 {
        return ((this.bits[slot >>> 5] >>> (slot & 31)) & 1) as 0 | 1;
    }

    /**
     * Set/clear the allocation bit of `slot` and update the sum-tree path so
     * `count`/`decodeBit*` stay valid without a full `reduce`.
     */
    setBit(slot: number, state: boolean): void {
        const cur = this.getBit(slot);
        const next = state ? 1 : 0;
        if (cur === next) return;
        const w = slot >>> 5;
        const m = 1 << (slot & 31);
        if (state) this.bits[w] |= m;
        else this.bits[w] &= ~m;
        const delta = next - cur;
        for (let i = this.capacity + slot; i >= 1; i >>>= 1) {
            this.tree[i] += delta;
        }
    }

    /** Rebuild the whole sum-tree from the bitfield (use after a bulk bitfield load). */
    reduce(): void {
        const cap = this.capacity;
        for (let slot = 0; slot < cap; slot++) {
            this.tree[cap + slot] = this.getBit(slot);
        }
        for (let i = cap - 1; i >= 1; i--) {
            this.tree[i] = this.tree[2 * i] + this.tree[2 * i + 1];
        }
    }

    /** Number of allocated slots (sum-tree root). */
    count(): number {
        return this.tree[1];
    }

    /** Number of free slots. */
    freeCount(): number {
        return this.capacity - this.tree[1];
    }

    /**
     * Slot of the `handle`-th allocated bit (0-based, ascending). Mirrors
     * `decode_bit`: descend, going left while `handle < leftSubtreeCount`, else
     * right (subtracting). Requires `handle < count()`.
     */
    decodeBit(handle: number): number {
        let id = 1;
        for (let d = 0; d < this.depth; d++) {
            const left = this.tree[2 * id];
            if (handle < left) {
                id = 2 * id;
            } else {
                handle -= left;
                id = 2 * id + 1;
            }
        }
        return id - this.capacity;
    }

    /**
     * Slot of the `handle`-th free bit (0-based, ascending). Mirrors
     * `decode_bit_complement`: free-in-subtree = halvedCapacity - allocatedCount.
     * Requires `handle < freeCount()`.
     */
    decodeBitComplement(handle: number): number {
        let id = 1;
        let c = this.capacity >>> 1;
        for (let d = 0; d < this.depth; d++) {
            const freeLeft = c - this.tree[2 * id];
            if (handle < freeLeft) {
                id = 2 * id;
            } else {
                handle -= freeLeft;
                id = 2 * id + 1;
            }
            c >>>= 1;
        }
        return id - this.capacity;
    }

    /**
     * Allocate `n` free slots (lowest free slots first) and return their indices.
     * Throws if there is not enough free capacity. Mirrors the GPU Allocate pass
     * (reserve via `decode_bit_complement`, then set the bit).
     */
    allocate(n = 1): number[] {
        if (n > this.freeCount()) {
            throw new Error(`OCBT pool out of memory: need ${n}, free ${this.freeCount()}`);
        }
        const out: number[] = [];
        for (let k = 0; k < n; k++) {
            // The 0-th free slot shifts up as we set bits, so always take index 0.
            const slot = this.decodeBitComplement(0);
            this.setBit(slot, true);
            out.push(slot);
        }
        return out;
    }

    /** Free a previously-allocated slot. */
    free(slot: number): void {
        this.setBit(slot, false);
    }

    /** Allocated slots in ascending order (debug/test helper). */
    allocatedSlots(): number[] {
        const out: number[] = [];
        const n = this.count();
        for (let i = 0; i < n; i++) out.push(this.decodeBit(i));
        return out;
    }
}
