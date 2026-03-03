import { describe, expect, it, vi } from 'vitest';
import { DisposableRegistry } from './disposable_registry';

describe('DisposableRegistry', () => {
    it('runs disposers in reverse order and once', () => {
        const registry = new DisposableRegistry();
        const calls: string[] = [];

        registry.add(() => calls.push('first'));
        registry.add(() => calls.push('second'));
        registry.dispose();
        registry.dispose();

        expect(calls).toEqual(['second', 'first']);
    });

    it('disposes immediately when already disposed', () => {
        const registry = new DisposableRegistry();
        const disposer = vi.fn();

        registry.dispose();
        registry.add(disposer);

        expect(disposer).toHaveBeenCalledTimes(1);
    });
});
