import {
    Scene,
    Mesh,
    Vector3,
    VertexData,
    ShaderMaterial,
    Texture,
    Effect,
} from "@babylonjs/core";
import { OriginCamera } from "../utils/OriginCamera";
import { Face, Bounds } from "./quadtree/QuadTree";
import { PlanetData } from "./PlanetData";

import textureNoTileShader from "../shaders/terrain/_textureNoTile.glsl?raw";
import terrainTriplanarShader from "../shaders/terrain/_terrainTriplanar.glsl?raw";
import terrainMorphingShader from "../shaders/terrain/_terrainMorphing.glsl?raw";
import terrainNoiseShader from "../shaders/terrain/_terrainNoiseShader.glsl?raw";
import terrainDebugLODShader from "../shaders/terrain/_terrainDebugLOD.glsl?raw";

import terrainVertexShader from "../shaders/terrain/terrainVertexShader.glsl?raw";
import terrainFragmentShader from "../shaders/terrain/terrainFragmentShader.glsl?raw";
import { ScaleManager } from "../utils/ScaleManager";

Effect.IncludesShadersStore["textureNoTile"] = textureNoTileShader;
Effect.IncludesShadersStore["triplanar"] = terrainTriplanarShader;
Effect.IncludesShadersStore["morphing"] = terrainMorphingShader;
Effect.IncludesShadersStore["noise"] = terrainNoiseShader;
Effect.IncludesShadersStore["debugLOD"] = terrainDebugLODShader;

Effect.ShadersStore["terrainVertexShader"] = terrainVertexShader;
Effect.ShadersStore["terrainFragmentShader"] = terrainFragmentShader;

export class Terrain {
    /**
     * Transforme les coordonnées (u, v) en coordonnées du cube selon la face.
     * Les valeurs de u et v doivent déjà être "ajustées" via tan() dans la méthode createPatchMesh.
     * @param u Coordonnée u.
     * @param v Coordonnée v.
     * @param face Face de la planète.
     * @returns Coordonnées dans l'espace cube.
     */
    static mapUVtoCube(u: number, v: number, face: Face): Vector3 {
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

    /**
     * Génère et retourne un maillage pour un patch de terrain.
     * Cette version utilise une interpolation angulaire basée sur les bornes du patch
     * pour obtenir des positions plus uniformes, et découpe chaque cellule du quadrillage
     * selon la diagonale la plus courte pour obtenir des triangles plus équilibrés.
     *
     * @param scene Scène BabylonJS.
     * @param bounds Bornes du patch (u,v ∈ [-1,1]) propres à ce chunk.
     * @param resolution Résolution de la grille.
     * @param radius Rayon de la sphère.
     * @param face Face à générer.
     * @param level Niveau de subdivision (utilisé dans le nom du mesh).
     * @returns Le maillage créé.
     */
    static createPatchMesh(
        scene: Scene,
        camera: OriginCamera,
        bounds: Bounds,
        resolution: number,
        radius: number,
        face: Face,
        level: number,
        maxLevel: number
    ): Mesh {
        const positions: number[] = [];
        const indices: number[] = [];
        const normals: number[] = [];
        const uvs: number[] = [];
        const res = resolution;
        const lodRanges: number[] = [];

        // Calculer les angles limites à partir des bornes
        const angleUMin = Math.atan(bounds.uMin);
        const angleUMax = Math.atan(bounds.uMax);
        const angleVMin = Math.atan(bounds.vMin);
        const angleVMax = Math.atan(bounds.vMax);

        // Tableau temporaire pour stocker les vertices en tant que Vector3
        const verts: Vector3[] = [];

        // Interpoler sur l'intervalle angulaire correspondant aux bornes du patch
        for (let i = 0; i <= res; i++) {
            const angleV = angleVMin + (angleVMax - angleVMin) * (i / res);
            const vAng = Math.tan(angleV); // Génère une coordonnée dans l'intervalle correspondant
            for (let j = 0; j <= res; j++) {
                const angleU = angleUMin + (angleUMax - angleUMin) * (j / res);
                const uAng = Math.tan(angleU);

                // Transformation selon la face
                const posCube = this.mapUVtoCube(uAng, vAng, face);

                // Projection sur la sphère : normaliser et mettre à l'échelle
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

        // Construction des indices pour chaque cellule du quadrillage.
        // Pour chaque cellule, on choisit la diagonale la plus courte pour découper le quadrilatère en deux triangles.
        for (let i = 0; i < res; i++) {
            for (let j = 0; j < res; j++) {
                const index0 = i * (res + 1) + j;
                const index1 = index0 + 1;
                const index2 = (i + 1) * (res + 1) + j;
                const index3 = index2 + 1;

                const v0 = verts[index0] as Vector3;
                const v1 = verts[index1] as Vector3;
                const v2 = verts[index2] as Vector3;
                const v3 = verts[index3] as Vector3;

                const d1 = Vector3.Distance(v0, v3); // Diagonale de v0 à v3
                const d2 = Vector3.Distance(v1, v2); // Diagonale de v1 à v2

                if (d1 < d2) {
                    // Découpage avec la diagonale de v0 à v3, ordre inversé
                    indices.push(index0, index3, index1);
                    indices.push(index0, index2, index3);
                } else {
                    // Découpage avec la diagonale de v1 à v2, ordre inversé
                    indices.push(index0, index2, index1);
                    indices.push(index1, index2, index3);
                }
            }
        }

        const customMesh = new Mesh("patch_" + level + "_" + face, scene);

        const vertexData = new VertexData();
        vertexData.positions = positions;
        vertexData.indices = indices;
        vertexData.normals = normals;
        vertexData.uvs = uvs;
        vertexData.applyToMesh(customMesh, true);

        // Création du ShaderMaterial
        const terrainShader = new ShaderMaterial(
            "terrainShader",
            scene,
            {
                vertex: "terrain",
                fragment: "terrain",
            },
            {
                attributes: ["position", "normal", "uv"],
                uniforms: [
                    "worldViewProjection",
                    "world",
                    "time",
                    "amplitude",
                    "frequency",
                    "mesh_dim",
                    "lodLevel",
                    "lodRangesLUT",
                    "cameraPosition",
                    "uPlanetCenter",
                    "showUV",
                    "debugUV",
                ],
                samplers: ["diffuseTexture", "detailTexture", "heightMap"],
            }
        );

        terrainShader.setInt("debugLOD", 1);
        terrainShader.setInt("debugUV", 0);

        // Paramètres par défaut
        terrainShader.setFloat("time", 0.0);
        terrainShader.setFloat("amplitude", 0.0);
        terrainShader.setFloat("frequency", 0.0);
        terrainShader.setFloat("mesh_dim", resolution);
        terrainShader.setFloat("lodLevel", level);
        console.log("lodLevel", level);

        terrainShader.setFloat("lodMaxLevel", maxLevel);
        console.log("lodMaxLevel", maxLevel);

        terrainShader.setVector3("cameraPosition", camera.doublepos);
        console.log("cameraPosition", camera.doublepos);

        for (let i = 0; i < maxLevel; i++) {
            lodRanges[i] =
                (ScaleManager.toSimulationUnits(
                    PlanetData.get("Mercury").diameter
                ) /
                    2) *
                Math.pow(2, i);
        }
        terrainShader.setFloats("lodRangesLUT", lodRanges);
        console.log("lodRangesLUT", lodRanges);

        terrainShader.setVector3(
            "uPlanetCenter",
            PlanetData.get("Mercury").position
        );

        terrainShader.setTexture(
            "heightMap",
            new Texture("textures/heightmap.ktx2", scene)
        );
        terrainShader.setFloat("heightFactor", 20.0);

        // Diffuse
        terrainShader.setTexture(
            "diffuseTexture",
            new Texture("textures/rock_face_diff_8k.png", scene)
        );
        terrainShader.setFloat("textureScale", 0.0002);

        // Detail
        terrainShader.setTexture(
            "detailTexture",
            new Texture("textures/rock_face_diff_8k.png", scene)
        );
        terrainShader.setFloat("detailScale", 0.1);
        terrainShader.setFloat("detailBlend", 1.0);

        terrainShader.wireframe = true;
        customMesh.checkCollisions = true;
        customMesh.material = terrainShader;

        return customMesh;
    }

    /**
     * Calcule et renvoie les données géométriques pour un patch de terrain.
     * Cette méthode est destinée à être utilisée dans un Web Worker.
     *
     * @param bounds Bornes du patch (u,v ∈ [-1,1]).
     * @param resolution Résolution de la grille.
     * @param radius Rayon de la sphère.
     * @param face Face à générer.
     * @param level Niveau de subdivision.
     * @param maxLevel Niveau maximum (peut être utilisé pour certains calculs spécifiques).
     * @returns Un objet contenant positions, indices, normales et uvs.
     */
    static computePatchMeshData(
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

        // Stocker temporairement les vertices en tant que Vector3
        const verts: Vector3[] = [];

        // Interpoler sur l'intervalle angulaire correspondant aux bornes du patch
        for (let i = 0; i <= res; i++) {
            const angleV = angleVMin + (angleVMax - angleVMin) * (i / res);
            const vAng = Math.tan(angleV);
            for (let j = 0; j <= res; j++) {
                const angleU = angleUMin + (angleUMax - angleUMin) * (j / res);
                const uAng = Math.tan(angleU);

                // Transformation selon la face
                const posCube = this.mapUVtoCube(uAng, vAng, face);

                // Projection sur la sphère : normaliser et mettre à l'échelle
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

        // Construction des indices pour chaque cellule du quadrillage.
        // Pour chaque cellule, choisir la diagonale la plus courte pour découper le quadrilatère en deux triangles.
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

                const d1 = Vector3.Distance(v0, v3); // Diagonale de v0 à v3
                const d2 = Vector3.Distance(v1, v2); // Diagonale de v1 à v2

                if (d1 < d2) {
                    // Découpage avec la diagonale de v0 à v3
                    indices.push(index0, index3, index1);
                    indices.push(index0, index2, index3);
                } else {
                    // Découpage avec la diagonale de v1 à v2
                    indices.push(index0, index2, index1);
                    indices.push(index1, index2, index3);
                }
            }
        }

        return { positions, indices, normals, uvs };
    }

    /**
     * Crée un Mesh Babylon.js à partir des données géométriques fournies.
     * Cette méthode est appelée une fois que le Worker a terminé ses calculs.
     *
     * @param scene Scène Babylon.js.
     * @param meshData Données géométriques calculées (positions, indices, normales, uvs).
     * @returns Le Mesh construit à partir de ces données.
     */
    static createMeshFromData(
        scene: Scene,
        meshData: {
            positions: number[];
            indices: number[];
            normals: number[];
            uvs: number[];
        },
        face: Face,
        level: number
    ): Mesh {
        const customMesh = new Mesh("patch_" + level + "_" + face, scene);

        const vertexData = new VertexData();
        vertexData.positions = meshData.positions;
        vertexData.indices = meshData.indices;
        vertexData.normals = meshData.normals;
        vertexData.uvs = meshData.uvs;
        vertexData.applyToMesh(customMesh, true);

        return customMesh;
    }
}
