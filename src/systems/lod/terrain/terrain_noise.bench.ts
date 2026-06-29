import { bench, describe } from 'vitest';
import { DEFAULT_NOISE, fbmNoise, type NoiseParams } from './terrain_noise';

// A spread of sample points on the unit sphere so the perm table / branch
// predictor see varied input rather than one hot cell.
const SAMPLES: ReadonlyArray<readonly [number, number, number]> = Array.from(
    { length: 256 },
    (_unused, i) => {
        const phi = (i * 2.399963) % (Math.PI * 2); // golden-angle spiral
        const y = 1 - (2 * (i + 0.5)) / 256;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        return [Math.cos(phi) * r, y, Math.sin(phi) * r] as const;
    }
);

function sweep(params: NoiseParams): number {
    let acc = 0;
    for (const [x, y, z] of SAMPLES) {
        acc += fbmNoise(x, y, z, params);
    }
    return acc;
}

describe('fbmNoise (256-point sphere sweep)', () => {
    bench('8 octaves (DEFAULT_NOISE)', () => {
        sweep(DEFAULT_NOISE);
    });

    bench('4 octaves', () => {
        sweep({ ...DEFAULT_NOISE, octaves: 4 });
    });

    bench('1 octave', () => {
        sweep({ ...DEFAULT_NOISE, octaves: 1 });
    });
});
