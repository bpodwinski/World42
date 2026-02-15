import { Vector3 } from "@babylonjs/core";

export type OrbitBodyId = string;

export interface OrbitBodyState {
    id: OrbitBodyId;
    massKg: number;

    // World / Double
    posWorldDouble: Vector3;
    velWorldDouble: Vector3;

    // options
    isFixed?: boolean;        // ne bouge pas (ex: étoile)
    affectsGravity?: boolean; // agit comme source de gravité (default true)
}

export interface OrbitIntegrator {
    step(bodies: OrbitBodyState[], dtSim: number): void;
}
