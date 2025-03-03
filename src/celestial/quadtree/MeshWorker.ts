import { Vector3 } from "@babylonjs/core";
import { Bounds, Face } from "./QuadTree";

// La fonction d'aide qui calcule les données géométriques (inspirée de createPatchMesh)
function computePatchMeshData(
    bounds: Bounds,
    resolution: number,
    radius: number,
    face: Face,
    level: number,
    maxLevel: number
): {
    positions: number[];
    indices: number[];
    normals: number[];
    uvs: number[];
} {
    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const res = resolution;

    // Calculer les angles limites à partir des bornes
    const angleUMin = Math.atan(bounds.uMin);
    const angleUMax = Math.atan(bounds.uMax);
    const angleVMin = Math.atan(bounds.vMin);
    const angleVMax = Math.atan(bounds.vMax);

    // Tableau temporaire pour stocker les vertices
    const verts: Vector3[] = [];

    for (let i = 0; i <= res; i++) {
        const angleV = angleVMin + (angleVMax - angleVMin) * (i / res);
        const vAng = Math.tan(angleV);
        for (let j = 0; j <= res; j++) {
            const angleU = angleUMin + (angleUMax - angleUMin) * (j / res);
            const uAng = Math.tan(angleU);

            // Transformation selon la face
            const posCube = mapUVtoCube(uAng, vAng, face);

            // Projection sur la sphère
            const posSphere = posCube.normalize().scale(radius);
            verts.push(posSphere);
            positions.push(posSphere.x, posSphere.y, posSphere.z);
            normals.push(
                posSphere.x / radius,
                posSphere.y / radius,
                posSphere.z / radius
            );
            uvs.push(j / res, i / res);
        }
    }

    // Construction des indices
    for (let i = 0; i < res; i++) {
        for (let j = 0; j < res; j++) {
            const index0 = i * (res + 1) + j;
            const index1 = index0 + 1;
            const index2 = (i + 1) * (res + 1) + j;
            const index3 = index2 + 1;

            const v0 = verts[index0];
            const v1 = verts[index1];
            const v2 = verts[index2];
            const v3 = verts[index3];

            const d1 = Vector3.Distance(v0, v3);
            const d2 = Vector3.Distance(v1, v2);

            if (d1 < d2) {
                indices.push(index0, index3, index1);
                indices.push(index0, index2, index3);
            } else {
                indices.push(index0, index2, index1);
                indices.push(index1, index2, index3);
            }
        }
    }

    return { positions, indices, normals, uvs };
}

// Fonction helper pour transformer UV en coordonnées cube
function mapUVtoCube(u: number, v: number, face: Face): Vector3 {
    switch (face) {
        case "front":
            return new Vector3(u, v, 1);
        case "back":
            return new Vector3(-u, v, -1);
        case "left":
            return new Vector3(-1, v, u);
        case "right":
            return new Vector3(1, v, -u);
        case "top":
            return new Vector3(u, 1, -v);
        case "bottom":
            return new Vector3(u, -1, v);
        default:
            return new Vector3(u, v, 1);
    }
}

// Gestion du message reçu par le Worker
self.onmessage = (event: MessageEvent) => {
    const { bounds, resolution, radius, face, level, maxLevel } = event.data;
    const meshData = computePatchMeshData(
        bounds,
        resolution,
        radius,
        face,
        level,
        maxLevel
    );

    self.postMessage(meshData);
};
