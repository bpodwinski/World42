/**
 * This worker is designed to compute the mesh data for a terrain chunk
 * It offloads heavy mesh computation to a separate thread so that the main application remains responsive
 * The worker calculates positions, indices, normals, and UV coordinates required for the mesh
 * It uses a minimal implementation of the Vector3 class for essential vector operations
 * The parameters (UV bounds, grid resolution, sphere radius, and cube face) are used to generate the mesh data and post the result back to the main thread
 */

/**
 * Minimal implementation of a 3D vector
 */
class Vector3 {
    /**
     * Creates new instance of Vector3
     * @param {number} x - X component
     * @param {number} y - Y component
     * @param {number} z - Z component
     */
    constructor(x, y, z) {
        this.x = x;
        this.y = y;
        this.z = z;
    }

    /**
     * Calculates distance between two vectors
     * @param {Vector3} v1 - First vector
     * @param {Vector3} v2 - Second vector
     * @returns {number} Euclidean distance between v1 and v2
     */
    static Distance(v1, v2) {
        const dx = v2.x - v1.x;
        const dy = v2.y - v1.y;
        const dz = v2.z - v1.z;
        return Math.sqrt(dx * dx + dy * dy + dz * dz);
    }

    /**
     * Normalizes vector
     * @returns {Vector3} New normalized vector
     */
    normalize() {
        const len = Math.sqrt(
            this.x * this.x + this.y * this.y + this.z * this.z
        );
        if (len === 0) {
            // Avoid division by zero
            return new Vector3(0, 0, 0);
        }
        return new Vector3(this.x / len, this.y / len, this.z / len);
    }

    /**
     * Scales vector by a given scalar
     * @param {number} s - Scalar value to multiply
     * @returns {Vector3} New scaled vector
     */
    scale(s) {
        return new Vector3(this.x * s, this.y * s, this.z * s);
    }

    /**
     * Computes the cross product of two vectors
     * @param {Vector3} v - The other vector
     * @returns {Vector3} The resulting cross product vector
     */
    cross(v) {
        return new Vector3(
            this.y * v.z - this.z * v.y,
            this.z * v.x - this.x * v.z,
            this.x * v.y - this.y * v.x
        );
    }

    /**
     * Adds another vector to this one
     * @param {Vector3} v - The vector to add
     * @returns {Vector3} The resulting vector
     */
    add(v) {
        return new Vector3(this.x + v.x, this.y + v.y, this.z + v.z);
    }
}

/**
 * Calcule un bruit fractal multi-octaves à partir d'un générateur de bruit 3D (SimplexNoise)
 * @param {SimplexNoise} noise - Instance du générateur SimplexNoise
 * @param {number} x - Coordonnée X
 * @param {number} y - Coordonnée Y
 * @param {number} z - Coordonnée Z
 * @param {number} octaves - Nombre d'octaves (4, 5, 6, ...)
 * @param {number} baseFrequency - Fréquence de départ
 * @param {number} baseAmplitude - Amplitude de départ
 * @param {number} lacunarity - Facteur de multiplication de la fréquence à chaque octave (souvent ~2.0)
 * @param {number} persistence - Facteur de multiplication de l'amplitude à chaque octave (souvent ~0.5)
 * @returns {number} Valeur normalisée du bruit fractal (≈ entre -1 et 1)
 */
function fractalNoise(
    noise,
    x,
    y,
    z,
    octaves = 4,
    baseFrequency = 1,
    baseAmplitude = 1,
    lacunarity = 2.0,
    persistence = 0.5
) {
    let sum = 0;
    let maxPossible = 0; // pour normaliser le résultat final
    let frequency = baseFrequency;
    let amplitude = baseAmplitude;

    for (let i = 0; i < octaves; i++) {
        // Pour chaque octave, on calcule le bruit, puis on l'ajoute au sum
        const value = noise.noise(x * frequency, y * frequency, z * frequency);
        sum += value * amplitude;

        // On additionne l'amplitude de l'octave courante pour la normalisation
        maxPossible += amplitude;

        // On passe à l'octave suivante
        frequency *= lacunarity;
        amplitude *= persistence;
    }

    // Normalise pour garder le résultat final dans ~[-1..1]
    return sum / maxPossible;
}

// Simplex Noise 3D (adapté pour le worker)
class SimplexNoise {
    constructor(seed = 0) {
        this.p = new Uint8Array(512);
        this.perm = new Uint8Array(512);
        for (let i = 0; i < 256; i++) {
            this.p[i] = i;
        }

        // Fisher-Yates shuffle
        let rng = seedrandom(seed);
        for (let i = 255; i > 0; i--) {
            const n = Math.floor(rng() * (i + 1));
            [this.p[i], this.p[n]] = [this.p[n], this.p[i]];
        }

        for (let i = 0; i < 512; i++) {
            this.perm[i] = this.p[i & 255];
        }
    }

    dot(g, x, y, z) {
        return g[0] * x + g[1] * y + g[2] * z;
    }

    noise(xin, yin, zin) {
        const grad3 = [
            [1, 1, 0],
            [-1, 1, 0],
            [1, -1, 0],
            [-1, -1, 0],
            [1, 0, 1],
            [-1, 0, 1],
            [1, 0, -1],
            [-1, 0, -1],
            [0, 1, 1],
            [0, -1, 1],
            [0, 1, -1],
            [0, -1, -1]
        ];

        const F3 = 1 / 3;
        const G3 = 1 / 6;

        let n0, n1, n2, n3;
        let s = (xin + yin + zin) * F3;
        let i = Math.floor(xin + s);
        let j = Math.floor(yin + s);
        let k = Math.floor(zin + s);
        let t = (i + j + k) * G3;
        let X0 = i - t;
        let Y0 = j - t;
        let Z0 = k - t;
        let x0 = xin - X0;
        let y0 = yin - Y0;
        let z0 = zin - Z0;

        let i1, j1, k1;
        let i2, j2, k2;
        if (x0 >= y0) {
            if (y0 >= z0) {
                i1 = 1;
                j1 = 0;
                k1 = 0;
                i2 = 1;
                j2 = 1;
                k2 = 0;
            } else if (x0 >= z0) {
                i1 = 1;
                j1 = 0;
                k1 = 0;
                i2 = 1;
                j2 = 0;
                k2 = 1;
            } else {
                i1 = 0;
                j1 = 0;
                k1 = 1;
                i2 = 1;
                j2 = 0;
                k2 = 1;
            }
        } else {
            if (y0 < z0) {
                i1 = 0;
                j1 = 0;
                k1 = 1;
                i2 = 0;
                j2 = 1;
                k2 = 1;
            } else if (x0 < z0) {
                i1 = 0;
                j1 = 1;
                k1 = 0;
                i2 = 0;
                j2 = 1;
                k2 = 1;
            } else {
                i1 = 0;
                j1 = 1;
                k1 = 0;
                i2 = 1;
                j2 = 1;
                k2 = 0;
            }
        }

        let x1 = x0 - i1 + G3;
        let y1 = y0 - j1 + G3;
        let z1 = z0 - k1 + G3;
        let x2 = x0 - i2 + 2 * G3;
        let y2 = y0 - j2 + 2 * G3;
        let z2 = z0 - k2 + 2 * G3;
        let x3 = x0 - 1 + 3 * G3;
        let y3 = y0 - 1 + 3 * G3;
        let z3 = z0 - 1 + 3 * G3;

        i &= 255;
        j &= 255;
        k &= 255;
        const gi0 = this.perm[i + this.perm[j + this.perm[k]]] % 12;
        const gi1 =
            this.perm[i + i1 + this.perm[j + j1 + this.perm[k + k1]]] % 12;
        const gi2 =
            this.perm[i + i2 + this.perm[j + j2 + this.perm[k + k2]]] % 12;
        const gi3 = this.perm[i + 1 + this.perm[j + 1 + this.perm[k + 1]]] % 12;

        const t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
        n0 =
            t0 < 0 ? 0 : t0 * t0 * (t0 * t0) * this.dot(grad3[gi0], x0, y0, z0);

        const t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
        n1 =
            t1 < 0 ? 0 : t1 * t1 * (t1 * t1) * this.dot(grad3[gi1], x1, y1, z1);

        const t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
        n2 =
            t2 < 0 ? 0 : t2 * t2 * (t2 * t2) * this.dot(grad3[gi2], x2, y2, z2);

        const t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
        n3 =
            t3 < 0 ? 0 : t3 * t3 * (t3 * t3) * this.dot(grad3[gi3], x3, y3, z3);

        return 32 * (n0 + n1 + n2 + n3); // valeur entre -1 et 1
    }
}

// Seedable RNG
function seedrandom(seed) {
    let x = Math.sin(seed) * 10000;
    return () => {
        x = Math.sin(x) * 10000;
        return x - Math.floor(x);
    };
}

/**
 * Computes mesh data for terrain chunk
 *
 * @param {{ uMin: number; uMax: number; vMin: number; vMax: number }} bounds - The UV bounds of the chunk
 * @param {number} resolution - The resolution of the grid
 * @param {number} radius - The radius of the sphere
 * @param {"front" | "back" | "left" | "right" | "top" | "bottom"} face - The face of the cube
 * @param {number} level - The current level of detail
 * @param {number} maxLevel - The maximum level of detail
 * @returns {{ positions: number[]; indices: number[]; normals: number[]; uvs: number[] }} The computed mesh data
 */
function computeChunkMeshData(bounds, resolution, radius, face, noise) {
    const positions = [];
    const indices = [];
    const normals = [];
    const uvs = [];
    const res = resolution;

    // Paramètres que vous ajusterez à votre convenance
    // ex : multiplier la fréquence de base pour mieux visualiser la différence
    const octaves = 8; // Nombre d'octaves
    const baseFrequency = 2.0; // Fréquence de base (on peut monter plus haut)
    const baseAmplitude = 4.0; // Amplitude de base
    const lacunarity = 2.5; // Multiplie la fréquence d'octave en octave
    const persistence = 0.5; // Multiplie l'amplitude d'octave en octave
    const globalTerrainAmplitude = 40.0; // Amplitude globale du relief

    // Calcul des angles U et V
    const angleUMin = Math.atan(bounds.uMin);
    const angleUMax = Math.atan(bounds.uMax);
    const angleVMin = Math.atan(bounds.vMin);
    const angleVMax = Math.atan(bounds.vMax);

    const verts = [];

    // Étape 1 : Générer les positions et UVs
    for (let i = 0; i <= res; i++) {
        const angleV = angleVMin + (angleVMax - angleVMin) * (i / res);

        for (let j = 0; j <= res; j++) {
            const angleU = angleUMin + (angleUMax - angleUMin) * (j / res);

            // Transform en coordonnées "cube" pour la face donnée
            const posCube = mapUVtoCube(
                Math.tan(angleU),
                Math.tan(angleV),
                face
            );

            // Normalise => vecteur unitaire
            let posSphere = posCube.normalize();

            // --- NOUVEL APPEL AU BRUIT FRACTAL ---
            // On applique fractalNoise() pour obtenir une valeur entre ~-1 et +1
            const fractalValue = fractalNoise(
                noise,
                posSphere.x,
                posSphere.y,
                posSphere.z,
                octaves,
                baseFrequency,
                baseAmplitude,
                lacunarity,
                persistence
            );

            // On multiplie par l'amplitude globale pour moduler la hauteur.
            // ex. fractalValue ~ [-1..+1], donc "elevation" ~ [-6..+6] si globalTerrainAmplitude=6
            const elevation = fractalValue * globalTerrainAmplitude;

            // On "scale" le rayon de la planète par cette élévation
            posSphere = posSphere.scale(radius + elevation);

            verts.push(posSphere);
            positions.push(posSphere.x, posSphere.y, posSphere.z);

            // Calcul de la normale (on repart du centre de la sphère vers l'extérieur).
            const adjustedRadius = radius + elevation;
            normals.push(
                posSphere.x / adjustedRadius,
                posSphere.y / adjustedRadius,
                posSphere.z / adjustedRadius
            );

            // UVs
            const u =
                (Math.atan2(posSphere.x, posSphere.z) + Math.PI) /
                (2 * Math.PI);
            const v = Math.acos(posSphere.y / (radius + elevation)) / Math.PI;

            uvs.push(u, v);
        }
    }

    // Étape 2 : Tableau pour accumuler les normales et compter les contributions
    const normalAccum = new Array(verts.length)
        .fill(null)
        .map(() => new Vector3(0, 0, 0));
    const normalCount = new Array(verts.length).fill(0);

    // Étape 3 : Générer les indices et calculer les normales des triangles
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

            let tri1Indices, tri2Indices;
            if (d1 < d2) {
                tri1Indices = [index0, index3, index1];
                tri2Indices = [index0, index2, index3];
                indices.push(index0, index3, index1, index0, index2, index3);
            } else {
                tri1Indices = [index0, index2, index1];
                tri2Indices = [index1, index2, index3];
                indices.push(index0, index2, index1, index1, index2, index3);
            }

            // Calculer les normales des deux triangles
            const tri1Normal = computeTriangleNormal(
                v0,
                verts[tri1Indices[1]],
                verts[tri1Indices[2]]
            );

            const tri2Normal = computeTriangleNormal(
                v0,
                verts[tri2Indices[1]],
                verts[tri2Indices[2]]
            );

            // Ajouter les normales aux vertices concernés
            tri1Indices.forEach((idx) => {
                normalAccum[idx] = normalAccum[idx].add(tri1Normal);
                normalCount[idx]++;
            });

            tri2Indices.forEach((idx) => {
                normalAccum[idx] = normalAccum[idx].add(tri2Normal);
                normalCount[idx]++;
            });
        }
    }

    // Étape 4 : Normaliser et remplir le tableau des normales
    for (let i = 0; i < verts.length; i++) {
        if (normalCount[i] > 0) {
            const avgNormal = normalAccum[i]
                .scale(1 / normalCount[i])
                .normalize();

            const idx = i * 3;
            normals[idx] = avgNormal.x;
            normals[idx + 1] = avgNormal.y;
            normals[idx + 2] = avgNormal.z;
        }
    }

    return { positions, indices, normals, uvs };
}

/**
 * Computes the normal of a triangle given three vertices
 * @param {Vector3} v0 - First vertex
 * @param {Vector3} v1 - Second vertex
 * @param {Vector3} v2 - Third vertex
 * @returns {Vector3} The normalized normal vector of the triangle
 */
function computeTriangleNormal(v0, v1, v2) {
    const edge1 = new Vector3(v1.x - v0.x, v1.y - v0.y, v1.z - v0.z);
    const edge2 = new Vector3(v2.x - v0.x, v2.y - v0.y, v2.z - v0.z);

    return edge2.cross(edge1).normalize();
}

/**
 * Maps UV coordinates to cube coordinates based on the specified face
 *
 * @param {number} u - U coordinate
 * @param {number} v - V coordinate
 * @param {"front" | "back" | "left" | "right" | "top" | "bottom"} face - Face of cube
 * @returns {Vector3} Corresponding 3D vector on the cube
 */
function mapUVtoCube(u, v, face) {
    switch (face) {
        case 'front':
            return new Vector3(u, v, 1);
        case 'back':
            return new Vector3(-u, v, -1);
        case 'left':
            return new Vector3(-1, v, u);
        case 'right':
            return new Vector3(1, v, -u);
        case 'top':
            return new Vector3(u, 1, -v);
        case 'bottom':
            return new Vector3(u, -1, v);
        default:
            return new Vector3(u, v, 1);
    }
}

/**
 * Handles incoming messages to the worker
 * Expects a message with properties: bounds, resolution, radius, face, level, and maxLevel
 * Computes the mesh data and posts the result back
 *
 * @param {MessageEvent} event - The message event containing the mesh parameters
 */
self.onmessage = (event) => {
    const start = performance.now();

    const { bounds, resolution, radius, face, seed } = event.data;
    const noiseInstance = new SimplexNoise(seed || 1);

    const meshData = computeChunkMeshData(
        bounds,
        resolution,
        radius,
        face,
        noiseInstance
    );

    self.postMessage(meshData);

    //console.log('Chunk created at: ' + (performance.now() - start) + 'ms');
};
