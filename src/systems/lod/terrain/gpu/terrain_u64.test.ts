import { describe, it, expect } from 'vitest';
import {
    u64,
    u64FromBigInt,
    u64ToBigInt,
    u64FromU32,
    u64Eq,
    u64And,
    u64Or,
    u64Xor,
    u64Not,
    u64Shl,
    u64Shr,
    u64FindMSB,
    u64Bit,
    u64Cmp,
    u64Gt,
    u64Lt,
    u64Depth,
    type U64
} from './ocbt_u64';

const MASK64 = (1n << 64n) - 1n;

/** Deterministic 64-bit sample generator (seeded LCG, no Math.random). */
function* sample64(count: number): Generator<bigint> {
    let s = 0x9e3779b9n;
    const a = 6364136223846793005n;
    const c = 1442695040888963407n;
    // A few hand-picked edge cases first, then pseudo-random spread.
    const edges = [
        0n,
        1n,
        0xffffffffn, // exactly the low lane full
        0x1_0000_0000n, // first bit of the high lane
        0xffff_ffff_ffff_ffffn, // all ones
        0x8000_0000_0000_0000n, // top bit only
        0xdead_beef_cafe_baben
    ];
    for (const e of edges) yield e;
    for (let i = 0; i < count; i++) {
        s = (a * s + c) & MASK64;
        yield s;
    }
}

describe('ocbt_u64 — lane layout & round-trip', () => {
    it('round-trips BigInt <-> [lo, hi] across the full 64-bit range', () => {
        for (const v of sample64(64)) {
            expect(u64ToBigInt(u64FromBigInt(v))).toBe(v);
        }
    });
    it('builds from 32-bit halves', () => {
        const x: U64 = u64(0x12345678, 0x9abcdef0);
        expect(u64ToBigInt(x)).toBe(0x9abcdef0_12345678n);
        expect(u64ToBigInt(u64FromU32(0xdeadbeef))).toBe(0xdeadbeefn);
    });
});

describe('ocbt_u64 — bitwise ops vs BigInt', () => {
    it('and / or / xor / not match BigInt', () => {
        const samples = [...sample64(48)];
        for (const av of samples) {
            for (const bv of samples) {
                const a = u64FromBigInt(av);
                const b = u64FromBigInt(bv);
                expect(u64ToBigInt(u64And(a, b))).toBe(av & bv);
                expect(u64ToBigInt(u64Or(a, b))).toBe(av | bv);
                expect(u64ToBigInt(u64Xor(a, b))).toBe(av ^ bv);
            }
            expect(u64ToBigInt(u64Not(u64FromBigInt(av)))).toBe(~av & MASK64);
        }
    });
});

describe('ocbt_u64 — shifts vs BigInt', () => {
    it('shl / shr match BigInt for every shift amount 0..63', () => {
        for (const v of sample64(40)) {
            const a = u64FromBigInt(v);
            for (let n = 0; n < 64; n++) {
                expect(u64ToBigInt(u64Shl(a, n))).toBe((v << BigInt(n)) & MASK64);
                expect(u64ToBigInt(u64Shr(a, n))).toBe(v >> BigInt(n));
            }
        }
    });
    it('handles the lane-boundary shifts (31, 32, 33) exactly', () => {
        const a = u64FromBigInt(0x0000_0001_8000_0001n);
        for (const n of [31, 32, 33]) {
            expect(u64ToBigInt(u64Shl(a, n))).toBe(
                (0x0000_0001_8000_0001n << BigInt(n)) & MASK64
            );
            expect(u64ToBigInt(u64Shr(a, n))).toBe(
                0x0000_0001_8000_0001n >> BigInt(n)
            );
        }
    });
});

describe('ocbt_u64 — findMSB / bit / depth', () => {
    it('findMSB matches the BigInt bit length', () => {
        expect(u64FindMSB(u64FromBigInt(0n))).toBe(-1);
        for (const v of sample64(48)) {
            if (v === 0n) continue;
            expect(u64FindMSB(u64FromBigInt(v))).toBe(v.toString(2).length - 1);
        }
    });
    it('bit extraction matches BigInt for every index 0..63', () => {
        for (const v of sample64(24)) {
            const a = u64FromBigInt(v);
            for (let i = 0; i < 64; i++) {
                expect(u64Bit(a, i)).toBe(Number((v >> BigInt(i)) & 1n));
            }
        }
    });
    it('depth equals firstLeadingBit (heap-id tree depth)', () => {
        // root face ids 8..15 sit at depth 3; deeper ids grow by one bit per level.
        expect(u64Depth(u64FromU32(8))).toBe(3);
        expect(u64Depth(u64FromU32(15))).toBe(3);
        expect(u64Depth(u64FromU32(16))).toBe(4);
        // A heap id near depth 60: root face shifted left 57 times.
        const deep = u64Shl(u64FromU32(8), 57);
        expect(u64Depth(deep)).toBe(60);
        expect(u64Depth(u64FromBigInt(0n))).toBe(0);
    });
});

describe('ocbt_u64 — comparison vs BigInt', () => {
    it('cmp / gt / lt match BigInt ordering', () => {
        const samples = [...sample64(40)];
        for (const av of samples) {
            for (const bv of samples) {
                const a = u64FromBigInt(av);
                const b = u64FromBigInt(bv);
                const expected = av < bv ? -1 : av > bv ? 1 : 0;
                expect(u64Cmp(a, b)).toBe(expected);
                expect(u64Gt(a, b)).toBe(av > bv);
                expect(u64Lt(a, b)).toBe(av < bv);
                expect(u64Eq(a, b)).toBe(av === bv);
            }
        }
    });
});
