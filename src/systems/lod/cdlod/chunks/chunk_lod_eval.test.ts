import { describe, expect, it } from 'vitest';
import { computeLodMorphFactor } from './chunk_lod_eval';

describe('computeLodMorphFactor', () => {
    const splitTh = 5.5;
    const mergeTh = 3.8;
    const den = splitTh - mergeTh;

    it('returns 0 near split threshold (fine shape)', () => {
        const morph = computeLodMorphFactor({ ssePx: splitTh, splitTh, mergeTh });
        expect(morph).toBe(0);
    });

    it('returns 1 near/under merge threshold (parent-like shape)', () => {
        const atMerge = computeLodMorphFactor({ ssePx: mergeTh, splitTh, mergeTh });
        const belowMerge = computeLodMorphFactor({ ssePx: mergeTh - 10, splitTh, mergeTh });
        expect(atMerge).toBe(1);
        expect(belowMerge).toBe(1);
    });

    it('uses a smooth transition window instead of linear full-range blend', () => {
        const beforeWindow = computeLodMorphFactor({
            ssePx: splitTh - den * 0.2,
            splitTh,
            mergeTh,
        });
        const midWindow = computeLodMorphFactor({
            ssePx: splitTh - den * 0.5,
            splitTh,
            mergeTh,
        });

        expect(beforeWindow).toBe(0);
        expect(midWindow).toBeCloseTo(0.5, 6);
    });
});
