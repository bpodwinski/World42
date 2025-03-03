const workerCode = `
    // Implémentation minimale de Vector3
    class Vector3 {
        constructor(x, y, z) {
            this.x = x;
            this.y = y;
            this.z = z;
        }

        static Distance(v1, v2) {
            const dx = v2.x - v1.x;
            const dy = v2.y - v1.y;
            const dz = v2.z - v1.z;
            return Math.sqrt(dx*dx + dy*dy + dz*dz);
        }

        normalize() {
            const len = Math.sqrt(this.x*this.x + this.y*this.y + this.z*this.z);
            if (len === 0) {
                // Éviter la division par zéro
                return new Vector3(0, 0, 0);
            }
            return new Vector3(this.x/len, this.y/len, this.z/len);
        }

        scale(s) {
            return new Vector3(this.x*s, this.y*s, this.z*s);
        }
    }

    // Type pour la gestion du patch
    // Note: on pourrait simplement utiliser un objet standard, 
    // mais on le documente sous forme de commentaire ici
    // type Bounds = { uMin: number; uMax: number; vMin: number; vMax: number };
    // type Face = "front" | "back" | "left" | "right" | "top" | "bottom";

    function computePatchMeshData(bounds, resolution, radius, face, level, maxLevel) {
        const positions = [];
        const indices = [];
        const normals = [];
        const uvs = [];
        const res = resolution;

        // Calculer les angles limites à partir des bornes
        const angleUMin = Math.atan(bounds.uMin);
        const angleUMax = Math.atan(bounds.uMax);
        const angleVMin = Math.atan(bounds.vMin);
        const angleVMax = Math.atan(bounds.vMax);

        // Tableau temporaire pour stocker les vertices
        const verts = [];

        for (let i = 0; i <= res; i++) {
            const angleV = angleVMin + (angleVMax - angleVMin)*(i/res);
            for (let j = 0; j <= res; j++) {
                const angleU = angleUMin + (angleUMax - angleUMin)*(j/res);
                // Transformation selon la face
                const posCube = mapUVtoCube(Math.tan(angleU), Math.tan(angleV), face);
                // Projection sur la sphère
                const posSphere = posCube.normalize().scale(radius);

                verts.push(posSphere);
                positions.push(posSphere.x, posSphere.y, posSphere.z);
                normals.push(posSphere.x/radius, posSphere.y/radius, posSphere.z/radius);
                uvs.push(j/res, i/res);
            }
        }

        // Construction des indices
        for (let i = 0; i < res; i++) {
            for (let j = 0; j < res; j++) {
                const index0 = i*(res+1) + j;
                const index1 = index0 + 1;
                const index2 = (i+1)*(res+1) + j;
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

    function mapUVtoCube(u, v, face) {
        switch (face) {
            case "front":   return new Vector3(u, v, 1);
            case "back":    return new Vector3(-u, v, -1);
            case "left":    return new Vector3(-1, v, u);
            case "right":   return new Vector3(1, v, -u);
            case "top":     return new Vector3(u, 1, -v);
            case "bottom":  return new Vector3(u, -1, v);
            default:        return new Vector3(u, v, 1);
        }
    }

    // Gestion du message reçu par le Worker
    self.onmessage = (event) => {
        const { bounds, resolution, radius, face, level, maxLevel } = event.data;
        const meshData = computePatchMeshData(bounds, resolution, radius, face, level, maxLevel);
        self.postMessage(meshData);
    };
`;

const blob = new Blob([workerCode], { type: "application/javascript" });
export const blobURL = URL.createObjectURL(blob);
