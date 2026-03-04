import { Vector3 } from '@babylonjs/core';

export type CbtNode = {
    id: number;
    level: number;
    parentId: number | null;
    leftId: number | null;
    rightId: number | null;
    v0: Vector3;
    v1: Vector3;
    v2: Vector3;
    isLeaf: boolean;
};

const ROOT_VERTICES = [
    new Vector3(1, 0, 0),
    new Vector3(-1, 0, 0),
    new Vector3(0, 1, 0),
    new Vector3(0, -1, 0),
    new Vector3(0, 0, 1),
    new Vector3(0, 0, -1),
] as const;

const ROOT_TRIANGLES: ReadonlyArray<readonly [number, number, number]> = [
    [0, 2, 4],
    [4, 2, 1],
    [1, 2, 5],
    [5, 2, 0],
    [4, 3, 0],
    [1, 3, 4],
    [5, 3, 1],
    [0, 3, 5],
];

type Triangle = {
    a: Vector3;
    b: Vector3;
    c: Vector3;
};

function orientOutward(a: Vector3, b: Vector3, c: Vector3): Triangle {
    const e0 = b.subtract(a);
    const e1 = c.subtract(a);
    const n = Vector3.Cross(e0, e1);
    const centroid = a.add(b).addInPlace(c).scaleInPlace(1 / 3);
    if (Vector3.Dot(n, centroid) >= 0) {
        return { a, b, c };
    }
    return { a, b: c, c: b };
}

function midpointOnSphere(a: Vector3, b: Vector3, radius: number): Vector3 {
    const m = a.add(b).scaleInPlace(0.5);
    if (m.lengthSquared() < 1e-12) {
        // Antipodal fallback; keeps a stable split axis in pathological cases.
        return a.clone().normalize().scaleInPlace(radius);
    }
    return m.normalize().scaleInPlace(radius);
}

function splitByLongestEdge(v0: Vector3, v1: Vector3, v2: Vector3, radius: number): [Triangle, Triangle] {
    const e01 = Vector3.DistanceSquared(v0, v1);
    const e12 = Vector3.DistanceSquared(v1, v2);
    const e20 = Vector3.DistanceSquared(v2, v0);

    if (e01 >= e12 && e01 >= e20) {
        const m = midpointOnSphere(v0, v1, radius);
        return [
            orientOutward(v0.clone(), m, v2.clone()),
            orientOutward(m.clone(), v1.clone(), v2.clone()),
        ];
    }

    if (e12 >= e20) {
        const m = midpointOnSphere(v1, v2, radius);
        return [
            orientOutward(v1.clone(), m, v0.clone()),
            orientOutward(m.clone(), v2.clone(), v0.clone()),
        ];
    }

    const m = midpointOnSphere(v2, v0, radius);
    return [
        orientOutward(v2.clone(), m, v1.clone()),
        orientOutward(m.clone(), v0.clone(), v1.clone()),
    ];
}

export class CbtState {
    private nodes = new Map<number, CbtNode>();
    private leafIds = new Set<number>();
    private nextId = 1;

    constructor(
        readonly radiusSim: number,
        readonly maxDepth: number
    ) {
        for (const [ia, ib, ic] of ROOT_TRIANGLES) {
            this.createRootNode(
                ROOT_VERTICES[ia].clone().scaleInPlace(radiusSim),
                ROOT_VERTICES[ib].clone().scaleInPlace(radiusSim),
                ROOT_VERTICES[ic].clone().scaleInPlace(radiusSim)
            );
        }
    }

    get leafCount(): number {
        return this.leafIds.size;
    }

    getLeafNodes(): CbtNode[] {
        const out: CbtNode[] = [];
        for (const id of this.leafIds) {
            const node = this.nodes.get(id);
            if (node) out.push(node);
        }
        return out;
    }

    splitByPriority(nodeIds: ReadonlyArray<number>, maxSplits: number): number {
        let splitCount = 0;
        for (const id of nodeIds) {
            if (splitCount >= maxSplits) break;
            if (this.split(id)) splitCount++;
        }
        return splitCount;
    }

    mergeByParentPriority(parentIds: ReadonlyArray<number>, maxMerges: number): number {
        let mergeCount = 0;
        for (const id of parentIds) {
            if (mergeCount >= maxMerges) break;
            if (this.merge(id)) mergeCount++;
        }
        return mergeCount;
    }

    private createRootNode(v0: Vector3, v1: Vector3, v2: Vector3): void {
        const oriented = orientOutward(v0, v1, v2);
        const id = this.nextId++;
        const node: CbtNode = {
            id,
            level: 0,
            parentId: null,
            leftId: null,
            rightId: null,
            v0: oriented.a,
            v1: oriented.b,
            v2: oriented.c,
            isLeaf: true,
        };
        this.nodes.set(id, node);
        this.leafIds.add(id);
    }

    private split(nodeId: number): boolean {
        const node = this.nodes.get(nodeId);
        if (!node || !node.isLeaf) return false;
        if (node.level >= this.maxDepth) return false;

        const [leftTriangle, rightTriangle] = splitByLongestEdge(
            node.v0,
            node.v1,
            node.v2,
            this.radiusSim
        );

        const leftId = this.nextId++;
        const rightId = this.nextId++;

        const leftNode: CbtNode = {
            id: leftId,
            level: node.level + 1,
            parentId: node.id,
            leftId: null,
            rightId: null,
            v0: leftTriangle.a,
            v1: leftTriangle.b,
            v2: leftTriangle.c,
            isLeaf: true,
        };

        const rightNode: CbtNode = {
            id: rightId,
            level: node.level + 1,
            parentId: node.id,
            leftId: null,
            rightId: null,
            v0: rightTriangle.a,
            v1: rightTriangle.b,
            v2: rightTriangle.c,
            isLeaf: true,
        };

        node.isLeaf = false;
        node.leftId = leftId;
        node.rightId = rightId;

        this.leafIds.delete(node.id);
        this.leafIds.add(leftId);
        this.leafIds.add(rightId);

        this.nodes.set(leftId, leftNode);
        this.nodes.set(rightId, rightNode);
        this.nodes.set(node.id, node);
        return true;
    }

    private merge(parentId: number): boolean {
        const parent = this.nodes.get(parentId);
        if (!parent || parent.isLeaf) return false;
        if (parent.leftId === null || parent.rightId === null) return false;

        const left = this.nodes.get(parent.leftId);
        const right = this.nodes.get(parent.rightId);
        if (!left || !right) return false;
        if (!left.isLeaf || !right.isLeaf) return false;

        this.leafIds.delete(left.id);
        this.leafIds.delete(right.id);
        this.nodes.delete(left.id);
        this.nodes.delete(right.id);

        parent.leftId = null;
        parent.rightId = null;
        parent.isLeaf = true;
        this.nodes.set(parent.id, parent);
        this.leafIds.add(parent.id);
        return true;
    }
}
