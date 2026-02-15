import { OrbitBodyState } from "./types";
import { LeapfrogNBodyIntegrator } from "./LeapfrogNBodyIntegrator";

export class OrbitSystem {
    constructor(
        private readonly bodies: OrbitBodyState[],
        private readonly integrator: LeapfrogNBodyIntegrator,
        private readonly timeScale = 1
    ) { }

    tick(dtSeconds: number): void {
        this.integrator.step(this.bodies, dtSeconds * this.timeScale);
    }
}
