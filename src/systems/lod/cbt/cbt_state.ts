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
            { a: v0.clone(), b: m, c: v2.clone() },
            { a: m.clone(), b: v1.clone(), c: v2.clone() },
        ];
    }

    if (e12 >= e20) {
        const m = midpointOnSphere(v1, v2, radius);
        return [
            { a: v1.clone(), b: m, c: v0.clone() },
            { a: m.clone(), b: v2.clone(), c: v0.clone() },
        ];
    }

    const m = midpointOnSphere(v2, v0, radius);
    return [
        { a: v2.clone(), b: m, c: v1.clone() },
        { a: m.clone(), b: v0.clone(), c: v1.clone() },
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

    private createRootNode(v0: Vector3, v1: Vector3, v2: Vector3): void {
        const id = this.nextId++;
        const node: CbtNode = {
            id,
            level: 0,
            parentId: null,
            leftId: null,
            rightId: null,
            v0,
            v1,
            v2,
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
}
