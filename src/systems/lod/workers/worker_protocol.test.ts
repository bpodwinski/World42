import { describe, expect, it } from 'vitest';
import {
    MESH_KERNEL_PROTOCOL,
    isMeshKernelMessage,
    type MeshKernelRequest,
    type MeshKernelResponse,
} from './worker_protocol';

describe('worker_protocol', () => {
    it('accepts valid request messages', () => {
        const request: MeshKernelRequest = {
            protocol: MESH_KERNEL_PROTOCOL,
            kind: 'build_chunk',
            id: 'job-1',
            payload: {
                bounds: { uMin: -1, uMax: 1, vMin: -1, vMax: 1 },
                resolution: 32,
                radius: 1000,
                face: 'front',
                level: 2,
                maxLevel: 8,
                noise: { seed: 1 },
                meshFormat: 'typed',
            },
        };

        expect(isMeshKernelMessage(request)).toBe(true);
    });

    it('accepts valid response messages', () => {
        const response: MeshKernelResponse = {
            protocol: MESH_KERNEL_PROTOCOL,
            kind: 'error',
            id: 'job-1',
            payload: {
                code: 'exception',
                message: 'boom',
            },
        };

        expect(isMeshKernelMessage(response)).toBe(true);
    });

    it('rejects malformed messages', () => {
        expect(isMeshKernelMessage(null)).toBe(false);
        expect(isMeshKernelMessage({})).toBe(false);
        expect(
            isMeshKernelMessage({
                protocol: MESH_KERNEL_PROTOCOL,
                id: 'x',
            })
        ).toBe(false);
        expect(
            isMeshKernelMessage({
                protocol: 'mesh-kernel/2',
                kind: 'ready',
            })
        ).toBe(false);
    });
});
