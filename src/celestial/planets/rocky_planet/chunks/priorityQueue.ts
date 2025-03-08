/**
 * A simple implementation of a priority queue based on a binary heap
 *
 * @typeparam T - The type of elements in the queue
 */
export class PriorityQueue<T> {
    private heap: T[] = [];
    private comparator: (a: T, b: T) => number;

    /**
     * Creates a new PriorityQueue instance.
     *
     * @param comparator - A function to compare two elements
     * It should return a negative number if the first element has a higher priority than the second,
     * zero if they are equal, or a positive number otherwise
     */
    constructor(comparator: (a: T, b: T) => number) {
        this.comparator = comparator;
    }

    /**
     * Adds an element to the queue
     *
     * @param item - The item to add
     */
    push(item: T): void {
        this.heap.push(item);
        this.bubbleUp();
    }

    /**
     * Removes and returns the highest priority element (the smallest according to the comparator)
     *
     * @returns The highest priority element, or undefined if the queue is empty
     */
    pop(): T | undefined {
        if (this.size() === 0) return undefined;
        const top = this.heap[0];
        const bottom = this.heap.pop()!;
        if (this.size() > 0) {
            this.heap[0] = bottom;
            this.bubbleDown();
        }
        return top;
    }

    /**
     * Returns the highest priority element without removing it from the queue
     *
     * @returns The highest priority element, or undefined if the queue is empty
     */
    peek(): T | undefined {
        return this.heap[0];
    }

    /**
     * Returns the number of elements in the queue
     *
     * @returns The size of the queue
     */
    size(): number {
        return this.heap.length;
    }

    private bubbleUp(): void {
        let index = this.heap.length - 1;
        while (index > 0) {
            const parentIndex = Math.floor((index - 1) / 2);
            if (this.comparator(this.heap[index], this.heap[parentIndex]) >= 0)
                break;
            this.swap(index, parentIndex);
            index = parentIndex;
        }
    }

    private bubbleDown(): void {
        let index = 0;
        const length = this.heap.length;
        while (true) {
            const leftIndex = 2 * index + 1;
            const rightIndex = 2 * index + 2;
            let smallest = index;

            if (
                leftIndex < length &&
                this.comparator(this.heap[leftIndex], this.heap[smallest]) < 0
            ) {
                smallest = leftIndex;
            }
            if (
                rightIndex < length &&
                this.comparator(this.heap[rightIndex], this.heap[smallest]) < 0
            ) {
                smallest = rightIndex;
            }
            if (smallest === index) break;
            this.swap(index, smallest);
            index = smallest;
        }
    }

    private swap(i: number, j: number): void {
        [this.heap[i], this.heap[j]] = [this.heap[j], this.heap[i]];
    }
}
