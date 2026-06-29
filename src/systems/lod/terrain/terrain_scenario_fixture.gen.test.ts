/**
 * Generator (not a behavioral test) for the Rust TERRAIN scenario fixture. It is
 * SKIPPED in normal runs and only executes when GEN_TERRAIN_FIXTURE=1, so it does not
 * affect the golden suite. It runs through vitest (not raw node) because the terrain
 * modules import each other with extensionless TS specifiers.
 *
 * Regenerate after changing the TS pipeline (state/classify/emit/noise):
 *   GEN_TERRAIN_FIXTURE=1 npx vitest run terrain_scenario_fixture.gen
 *
 * Drives the REAL pipeline (TerrainState + classifyLeaves + emit, exactly as
 * LocalTerrainSource) for a fixed frame sequence — camera close (refine) then receding
 * (merge), with backside + frustum culling — and dumps inputs + final topology +
 * final geometry as IEEE-754 hex bits to terrain/tests/terrain_scenario_fixture.txt.
 * The Rust test (terrain_state.rs / terrain_emit.rs) replays it and asserts bit-equality.
 */
import { it, expect } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Frustum, Matrix, Vector3, type Plane } from '@babylonjs/core';
import { TerrainState } from './terrain_state';
import { classifyLeaves } from './terrain_classify';
import { emitMeshFromLeaves } from './terrain_emit';
import { DEFAULT_NOISE } from './terrain_noise';

const GEN = process.env.GEN_TERRAIN_FIXTURE === '1';

const buf = new ArrayBuffer(8);
const f = new Float64Array(buf);
const u = new BigUint64Array(buf);
function b(x: number): string {
    f[0] = x;
    return u[0].toString(16).padStart(16, '0');
}

it.runIf(GEN)('generates the TERRAIN scenario fixture', () => {
    const radius = 2440.0; // ~Mercury, SCALE_FACTOR=1
    const maxDepth = 16;
    const noise = { ...DEFAULT_NOISE };
    const splitThresholdPx2 = 900;
    const splitHysteresis = 0.75;
    const cullBackface = true;
    const cullMinDot = -0.05;
    const frustumGuardScale = 1.0;
    const maxSplits = 20;
    const maxMerges = 20;
    const iters = 40;
    const viewportHeightPx = 1080;
    const fov = 0.8;
    const focal = viewportHeightPx / (2 * Math.tan(fov / 2)); // TS Math.tan — dumped, fed to Rust

    const planetCenter = new Vector3(0, 0, 0);
    const renderMat = Matrix.RotationYawPitchRoll(0.3, 0.2, 0.1);

    // Render-space frustum (camera at origin, looking toward the planet at -X).
    const aspect = 1920 / 1080;
    const view = Matrix.LookAtLH(Vector3.Zero(), new Vector3(-1, 0, 0), Vector3.Up());
    const proj = Matrix.PerspectiveFovLH(fov, aspect, 0.1, 1e9);
    const planes: Plane[] = Frustum.GetPlanes(view.multiply(proj));

    const camNear = new Vector3(radius * 1.4, 0, 0);
    const camFar = new Vector3(radius * 6.0, 0, 0);
    const cameras: Vector3[] = [];
    for (let i = 0; i < iters; i++) cameras.push(i < 24 ? camNear : camFar);

    const state = new TerrainState(radius, maxDepth);
    for (let i = 0; i < iters; i++) {
        const leaves = state.getLeafNodes();
        const { splitCandidates, mergeParents } = classifyLeaves({
            leaves,
            cameraWorldDouble: cameras[i],
            planetCenterWorldDouble: planetCenter,
            renderParentWorldMatrix: renderMat,
            viewportHeightPx,
            cameraFovRadians: fov,
            splitThresholdPx2,
            splitHysteresis,
            cullBackface,
            cullMinDot,
            frustumPlanes: planes,
            frustumGuardScale,
        });
        state.splitByPriority(
            splitCandidates.map((c) => c.nodeId),
            maxSplits
        );
        state.mergeByParentPriority(mergeParents, maxMerges);
    }

    const finalLeaves = state.getLeafNodes();
    const geom = emitMeshFromLeaves(finalLeaves, radius, { noise });

    const lines: string[] = [];
    lines.push('# terrain scenario fixture — f64 values are IEEE-754 hex bits');
    lines.push(
        `C ${b(radius)} ${maxDepth} ${noise.seed} ${noise.octaves} ${b(
            noise.baseFrequency
        )} ${b(noise.baseAmplitude)} ${b(noise.lacunarity)} ${b(noise.persistence)} ${b(
            noise.globalAmplitude
        )} ${b(planetCenter.x)} ${b(planetCenter.y)} ${b(planetCenter.z)}`
    );
    lines.push(
        `F ${b(splitThresholdPx2)} ${b(splitHysteresis)} ${cullBackface ? 1 : 0} ${b(
            cullMinDot
        )} ${b(frustumGuardScale)} ${maxSplits} ${maxMerges} ${iters} 1 ${b(focal)}`
    );
    lines.push(`MAT ${Array.from(renderMat.m, (x) => b(x)).join(' ')}`);
    for (const pl of planes) {
        lines.push(`PL ${b(pl.normal.x)} ${b(pl.normal.y)} ${b(pl.normal.z)} ${b(pl.d)}`);
    }
    for (const cam of cameras) {
        lines.push(`FRAME ${b(cam.x)} ${b(cam.y)} ${b(cam.z)}`);
    }
    for (const leaf of finalLeaves) {
        lines.push(
            `LEAF ${leaf.id} ${leaf.level} ${leaf.parentId ?? -1} ` +
                `${b(leaf.v0.x)} ${b(leaf.v0.y)} ${b(leaf.v0.z)} ` +
                `${b(leaf.v1.x)} ${b(leaf.v1.y)} ${b(leaf.v1.z)} ` +
                `${b(leaf.v2.x)} ${b(leaf.v2.y)} ${b(leaf.v2.z)}`
        );
    }
    lines.push(`POS ${Array.from(geom.positions, (x) => b(x)).join(' ')}`);
    lines.push(`NRM ${Array.from(geom.normals, (x) => b(x)).join(' ')}`);
    lines.push(`UVS ${Array.from(geom.uvs, (x) => b(x)).join(' ')}`);
    lines.push(`COL ${Array.from(geom.colors, (x) => b(x)).join(' ')}`);
    lines.push(
        `IDX ${geom.indices instanceof Uint32Array ? 32 : 16} ${Array.from(
            geom.indices
        ).join(' ')}`
    );

    const outPath = join(process.cwd(), 'terrain', 'tests', 'terrain_scenario_fixture.txt');
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');
    // eslint-disable-next-line no-console
    console.log(
        `wrote ${outPath}: ${finalLeaves.length} leaves, ${
            geom.positions.length / 3
        } verts, ${geom.indices.length} indices`
    );
    expect(finalLeaves.length).toBeGreaterThan(50);
});
