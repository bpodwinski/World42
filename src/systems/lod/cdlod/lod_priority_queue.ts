export type HeapItem<T> = { key: number; value: T; stamp: number };

/** Min-heap by key */
export class MinHeap<T> {
    private a: HeapItem<T>[] = [];

    size() { return this.a.length; }

    push(it: HeapItem<T>) {
        const a = this.a;
        a.push(it);
        let i = a.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (a[p].key <= a[i].key) break;
            [a[p], a[i]] = [a[i], a[p]];
            i = p;
        }
    }

    pop(): HeapItem<T> | undefined {
        const a = this.a;
        if (!a.length) return undefined;
        const top = a[0];
        const last = a.pop()!;
        if (a.length) {
            a[0] = last;
            let i = 0;
            for (; ;) {
                const l = i * 2 + 1;
                const r = l + 1;
                let m = i;
                if (l < a.length && a[l].key < a[m].key) m = l;
                if (r < a.length && a[r].key < a[m].key) m = r;
                if (m === i) break;
                [a[m], a[i]] = [a[i], a[m]];
                i = m;
            }
        }
        return top;
    }

    clear() { this.a.length = 0; }
}
