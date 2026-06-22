/**
 * Main-thread client for the off-thread CBT worker. Owns the single worker, runs
 * the init handshake, and routes `geometry_result`/`error` messages to per-planet
 * subscribers by key. Stateful and CBT-specific (no priority queue): each planet's
 * tree lives in the worker, so the client just forwards camera params and delivers
 * geometry back.
 */
import type { EmitResult } from '../cbt_emit';
import { getGlobalCbtWorker } from './global_cbt_worker';
import {
    CBT_KERNEL_PROTOCOL,
    isCbtMessage,
    type CbtCreatePlanetRequest,
    type CbtGeometryStats,
} from './cbt_worker_protocol';

export type CbtCreatePayload = CbtCreatePlanetRequest['payload'];

/** Delivered to a subscriber when the worker returns a result for its planet. */
export type CbtResultListener = (
    gen: number,
    geometry: EmitResult | null,
    stats: CbtGeometryStats
) => void;

export class CbtKernelClient {
    private readonly worker: Worker;
    private readonly ready: Promise<void>;
    private readonly routes = new Map<string, CbtResultListener>();
    private idCounter = 0;

    constructor(worker: Worker = getGlobalCbtWorker()) {
        this.worker = worker;
        this.worker.addEventListener('message', this.onMessage);
        this.ready = new Promise<void>((resolve) => {
            const onReady = (event: MessageEvent): void => {
                const msg = event.data;
                if (isCbtMessage(msg) && msg.kind === 'ready') {
                    this.worker.removeEventListener('message', onReady);
                    resolve();
                }
            };
            this.worker.addEventListener('message', onReady);
            this.worker.postMessage({
                protocol: CBT_KERNEL_PROTOCOL,
                kind: 'init',
                id: this.nextId(),
            });
        });
    }

    private nextId(): string {
        this.idCounter += 1;
        return `cbt-${this.idCounter}`;
    }

    /** Send queued after the worker is ready; order is preserved (microtask FIFO). */
    private send(message: object, transfer?: Transferable[]): void {
        this.ready.then(() => this.worker.postMessage(message, transfer ?? []));
    }

    subscribe(key: string, listener: CbtResultListener): void {
        this.routes.set(key, listener);
    }

    createPlanet(payload: CbtCreatePayload): void {
        this.send({
            protocol: CBT_KERNEL_PROTOCOL,
            kind: 'create_planet',
            id: this.nextId(),
            payload,
        });
    }

    update(
        key: string,
        gen: number,
        params: Float64Array,
        hasFrustum: boolean
    ): void {
        // params is NOT transferred — a 24/48-double structured-clone copy is cheaper
        // than reallocating the source's reusable buffer each frame.
        this.send({
            protocol: CBT_KERNEL_PROTOCOL,
            kind: 'update_planet',
            id: this.nextId(),
            payload: { key, gen, hasFrustum: hasFrustum ? 1 : 0, params },
        });
    }

    resetPlanet(key: string): void {
        this.send({
            protocol: CBT_KERNEL_PROTOCOL,
            kind: 'reset_planet',
            id: this.nextId(),
            payload: { key },
        });
    }

    disposePlanet(key: string): void {
        this.routes.delete(key);
        this.send({
            protocol: CBT_KERNEL_PROTOCOL,
            kind: 'dispose_planet',
            id: this.nextId(),
            payload: { key },
        });
    }

    private onMessage = (event: MessageEvent): void => {
        const msg = event.data;
        if (!isCbtMessage(msg)) return;
        if (msg.kind === 'geometry_result') {
            const route = this.routes.get(msg.payload.key);
            if (!route) return; // disposed / unknown — drop late result
            const geometry = msg.payload.geometryChanged
                ? (msg.payload.geometry as unknown as EmitResult)
                : null;
            route(msg.payload.gen, geometry, msg.payload.stats);
        } else if (msg.kind === 'error') {
            // eslint-disable-next-line no-console
            console.error(
                `[cbt-worker] ${msg.payload.code}: ${msg.payload.message}` +
                    (msg.payload.key ? ` (key=${msg.payload.key})` : '')
            );
        }
    };
}

let client: CbtKernelClient | null = null;

export function getGlobalCbtKernelClient(): CbtKernelClient {
    if (!client) client = new CbtKernelClient();
    return client;
}
