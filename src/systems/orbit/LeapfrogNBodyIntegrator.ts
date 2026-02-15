import { Vector3 } from "@babylonjs/core";
import { OrbitBodyState } from "./types";

export class LeapfrogNBodyIntegrator {
    constructor(
        private readonly Gsim: number,
        private readonly softeningSim = 1e-3
    ) { }

    step(bodies: OrbitBodyState[], dt: number): void {
        const n = bodies.length;

        const pos0 = bodies.map(b => b.posWorldDouble.clone());
        const vel0 = bodies.map(b => b.velWorldDouble.clone());

        const acc0 = this.acc(bodies, pos0);

        const vHalf: Vector3[] = new Array(n);
        const pos1: Vector3[] = new Array(n);

        for (let i = 0; i < n; i++) {
            const b = bodies[i];
            if (b.isFixed) {
                vHalf[i] = vel0[i];
                pos1[i] = pos0[i];
                continue;
            }
            vHalf[i] = vel0[i].add(acc0[i].scale(0.5 * dt));
            pos1[i] = pos0[i].add(vHalf[i].scale(dt));
        }

        const acc1 = this.acc(bodies, pos1);

        for (let i = 0; i < n; i++) {
            const b = bodies[i];
            if (b.isFixed) continue;
            const v1 = vHalf[i].add(acc1[i].scale(0.5 * dt));
            b.posWorldDouble.copyFrom(pos1[i]);
            b.velWorldDouble.copyFrom(v1);
        }
    }

    private acc(bodies: OrbitBodyState[], pos: Vector3[]): Vector3[] {
        const n = bodies.length;
        const out = Array.from({ length: n }, () => new Vector3(0, 0, 0));

        for (let i = 0; i < n; i++) {
            for (let j = 0; j < n; j++) {
                if (i === j) continue;
                const src = bodies[j];
                if (src.affectsGravity === false) continue;

                const r = pos[j].subtract(pos[i]);
                const d2 = r.lengthSquared() + this.softeningSim * this.softeningSim;
                const invD = 1 / Math.sqrt(d2);
                const invD3 = invD * invD * invD;

                out[i].addInPlace(r.scale(this.Gsim * src.massKg * invD3));
            }
        }
        return out;
    }
}
