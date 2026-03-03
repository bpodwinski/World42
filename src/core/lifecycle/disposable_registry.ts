import type { Observable, Observer } from '@babylonjs/core';

type Disposer = () => void;

/**
 * Centralized registry for teardown callbacks (DOM listeners, observers, custom disposers).
 */
export class DisposableRegistry {
    private readonly disposers: Disposer[] = [];
    private disposed = false;

    add(disposer: Disposer): void {
        if (this.disposed) {
            disposer();
            return;
        }
        this.disposers.push(disposer);
    }

    addDomListener<K extends keyof WindowEventMap>(
        target: Window,
        type: K,
        listener: (event: WindowEventMap[K]) => void,
        options?: boolean | AddEventListenerOptions
    ): void;
    addDomListener<K extends keyof DocumentEventMap>(
        target: Document,
        type: K,
        listener: (event: DocumentEventMap[K]) => void,
        options?: boolean | AddEventListenerOptions
    ): void;
    addDomListener<K extends keyof HTMLElementEventMap>(
        target: HTMLElement,
        type: K,
        listener: (event: HTMLElementEventMap[K]) => void,
        options?: boolean | AddEventListenerOptions
    ): void;
    addDomListener(
        target: EventTarget,
        type: string,
        listener: (event: Event) => void,
        options?: boolean | AddEventListenerOptions
    ): void {
        target.addEventListener(type, listener, options);
        this.add(() => target.removeEventListener(type, listener, options));
    }

    addBabylonObserver<T>(
        observable: Observable<T>,
        observer: Observer<T> | null
    ): void {
        if (!observer) return;
        this.add(() => observable.remove(observer));
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;

        for (let i = this.disposers.length - 1; i >= 0; i--) {
            this.disposers[i]();
        }
        this.disposers.length = 0;
    }
}
