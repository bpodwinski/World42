import { Vector3 } from "@babylonjs/core";

export interface AtmosphericScatteringSettings {
    rayleighHeight: number;
    rayleighScatteringCoefficients: Vector3;
    mieHeight: number;
    mieScatteringCoefficients: Vector3;
    mieAsymmetry: number;
    ozoneHeight: number;
    ozoneAbsorptionCoefficients: Vector3;
    ozoneFalloff: number;
    lightIntensity: number;
}
