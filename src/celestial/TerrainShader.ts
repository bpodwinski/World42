import {
    Mesh,
    Scene,
    ShaderMaterial,
    Texture,
    Vector3,
    VertexData,
} from "@babylonjs/core";
import { PlanetData } from "./PlanetData";
import { ScaleManager } from "../utils/ScaleManager";
import { Face } from "./quadtree/QuadTree";

/**
 * TerrainShader creates and configures ShaderMaterial for terrain rendering
 *
 * Centralizes shader configuration and makes it reusable across terrain chunks
 */
export class TerrainShader {
    private scene: Scene;

    /**
     * Creates new TerrainShader instance using provided scene
     *
     * @param {Scene} scene - Babylon.js scene for shader creation
     */
    constructor(scene: Scene) {
        this.scene = scene;
    }

    /**
     * Creates and configures a ShaderMaterial for terrain rendering
     *
     * @param {number} resolution - Grid resolution for terrain chunk
     * @param {number} lodLevel - Current level of detail
     * @param {number} maxLevel - Maximum level of detail
     * @param {Vector3} cameraPosition - Camera position in world space
     * @param {boolean} [wireframe=false] - Enable or disable wireframe mode
     * @param {boolean} [debugLOD=false] - Enable or disable debug mode for LOD
     * @returns {ShaderMaterial} Configured ShaderMaterial for terrain
     */
    create(
        resolution: number,
        lodLevel: number,
        maxLevel: number,
        cameraPosition: Vector3,
        wireframe: boolean = false,
        debugLOD: boolean = false
    ): ShaderMaterial {
        const shader = new ShaderMaterial(
            "terrainShader",
            this.scene,
            { vertex: "terrain", fragment: "terrain" },
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
                samplers: [
                    "diffuseTexture",
                    "detailTexture",
                    "normalMap",
                    "heightMap",
                ],
            }
        );

        shader.setInt("debugLOD", debugLOD ? 1 : 0);
        shader.setInt("debugUV", 0);

        shader.setFloat("time", 0.0);
        shader.setFloat("amplitude", 0.0);
        shader.setFloat("frequency", 0.0);
        shader.setFloat("mesh_dim", resolution);
        shader.setFloat("lodLevel", lodLevel);
        shader.setFloat("lodMaxLevel", maxLevel);
        shader.setVector3("cameraPosition", cameraPosition);

        const lodRanges: number[] = [];
        for (let i = 0; i < maxLevel; i++) {
            lodRanges[i] =
                (ScaleManager.toSimulationUnits(
                    PlanetData.get("Mercury").diameter
                ) /
                    2) *
                Math.pow(2, i);
        }
        shader.setFloats("lodRangesLUT", lodRanges);
        shader.setVector3("uPlanetCenter", PlanetData.get("Mercury").position);

        // Height
        shader.setTexture(
            "heightMap",
            new Texture("textures/moon_heightmap.ktx2", this.scene)
        );
        shader.setFloat("heightFactor", 15.0);

        // Diffuse
        shader.setTexture(
            "diffuseTexture",
            new Texture("textures/moon_diffuse.ktx2", this.scene)
        );
        shader.setFloat("textureScale", 1.0);

        // Normal
        shader.setTexture(
            "normalMap",
            new Texture("textures/moon_normal.ktx2", this.scene)
        );
        shader.setFloat("normalScale", 1.0);

        // Detail
        shader.setTexture(
            "detailTexture",
            new Texture("textures/moon_detail.ktx2", this.scene)
        );
        shader.setFloat("detailScale", 2.0);
        shader.setFloat("detailBlend", 1.0);

        shader.wireframe = wireframe;

        return shader;
    }

    /**
     * Crée un Mesh Babylon.js à partir des données géométriques fournies.
     * Cette méthode est appelée une fois que le Worker a terminé ses calculs.
     *
     * @param scene Scène Babylon.js.
     * @param meshData Données géométriques calculées (positions, indices, normales, uvs).
     * @returns Le Mesh construit à partir de ces données.
     */
    static createMeshFromWorker(
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
}
