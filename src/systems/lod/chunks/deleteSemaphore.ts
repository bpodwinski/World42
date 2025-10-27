/**
 * Interface representing a terrain chunk.
 */
export interface Chunk {
    /**
     * Releases the resources held by the chunk.
     */
    dispose(): void;

    /**
     * Indicates whether the chunk is fully loaded.
     *
     * @returns True if loaded, false otherwise.
     */
    isLoaded(): boolean;

    /**
     * Indicates whether the chunk has already been disposed.
     *
     * @returns True if disposed, false otherwise.
     */
    hasBeenDisposed(): boolean;
}

/**
 * The DeleteSemaphore is responsible for deleting old terrain chunks only when their replacements are fully loaded.
 * This prevents gaps or pop-ins in the rendered surface.
 */
export class DeleteSemaphore {
    readonly chunksToDelete: Chunk[];
    readonly newChunks: Chunk[];

    private resolved = false;

    /**
     * Creates a new DeleteSemaphore instance.
     *
     * @param newChunks - The new chunks that will replace the old ones.
     * @param chunksToDelete - The old chunks to be deleted once replacements are ready.
     */
    constructor(newChunks: Chunk[], chunksToDelete: Chunk[]) {
        this.newChunks = newChunks;
        this.chunksToDelete = chunksToDelete;
    }

    /**
     * Resolves the semaphore by disposing all chunks marked for deletion and clearing both arrays.
     *
     * @private
     */
    private resolve(): void {
        for (const chunk of this.chunksToDelete) {
            chunk.dispose();
        }
        this.chunksToDelete.length = 0;
        this.newChunks.length = 0;
        this.resolved = true;
    }

    /**
     * Updates the state of the semaphore.
     * If all new chunks are loaded, the semaphore is resolved.
     */
    public update(): void {
        if (this.isReadyToResolve()) {
            this.resolve();
        }
        this.resolveIfZombie();
    }

    /**
     * Checks if any new chunk has been disposed prematurely (i.e., a zombie chunk).
     * If such a case is detected, resolves the semaphore immediately.
     */
    public resolveIfZombie(): void {
        for (const chunk of this.newChunks) {
            if (chunk.hasBeenDisposed()) {
                this.resolve();
                return;
            }
        }
    }

    /**
     * Determines if the semaphore is ready to resolve by verifying that all new chunks are loaded.
     *
     * @returns True if all new chunks are loaded, false otherwise.
     */
    public isReadyToResolve(): boolean {
        let remaining = this.newChunks.length;
        this.newChunks.forEach((chunk) => {
            if (chunk.isLoaded()) {
                remaining--;
            }
        });
        return remaining === 0;
    }

    /**
     * Indicates whether the semaphore has been resolved.
     *
     * @returns True if resolved, false otherwise.
     */
    public isResolved(): boolean {
        return this.resolved;
    }

    /**
     * Disposes all chunks (both new and old) and clears the internal arrays.
     */
    public dispose(): void {
        this.chunksToDelete.forEach((chunk) => chunk.dispose());
        this.newChunks.forEach((chunk) => chunk.dispose());
        this.chunksToDelete.length = 0;
        this.newChunks.length = 0;
    }
}
