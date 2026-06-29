/**
 * In-game terrain options menu (Tweakpane). Auto-generated from TERRAIN_PARAM_SCHEMA: every editable
 * parameter becomes a labeled slider under its group folder, with the schema description as a tooltip.
 * Edits are persisted per profile to localStorage (terrain_profile_store) and survive reloads.
 *
 * Lives in the `app` layer (top): it depends on game_world config (profiles/schema/store) + tweakpane,
 * so it must NOT sit under core/ (dependencies flow downward).
 *
 * Apply model:
 *  - `uniform` params apply LIVE if a `liveApply` callback is supplied (no rebuild).
 *  - `baked` params are compiled into the WGSL header; "Apply" calls `onApply`, which HOT-REBUILDS the
 *    affected planets in place (lod.rebuildProfile) — no page reload. If `onApply` is omitted it falls
 *    back to a page reload (the loader re-bakes from localStorage at startup).
 *
 * Toggle with the O key (configurable). American English only.
 */

import { Pane, type FolderApi } from 'tweakpane';
import {
    PLANET_PROFILES,
    PROFILE_IDS,
    DEFAULT_PROFILE_ID
} from '../game_world/stellar_system/planet_profiles';
import { TERRAIN_PARAM_SCHEMA } from '../game_world/stellar_system/terrain_param_schema';
import {
    clearProfileOverrides,
    resolveEffectiveProfile,
    setOverride
} from '../game_world/stellar_system/terrain_profile_store';

export type TerrainOptionsMenuOptions = {
    /** Profile selected when the menu opens (default DEFAULT_PROFILE_ID). */
    initialProfileId?: string;
    /** Key that toggles the menu (default 'o'). */
    toggleKey?: string;
    /** Apply `uniform` params live (no rebuild). Receives (profileId, path, value). */
    liveApply?: (profileId: string, path: string, value: number) => void;
    /** Apply `baked` params. Default reloads the page; pass lod.rebuildProfile to hot-rebuild. */
    onApply?: (profileId: string) => void;
};

export class TerrainOptionsMenu {
    private pane!: Pane;
    private readonly container: HTMLDivElement;
    private profileId: string;
    private working: Record<string, unknown> = {};
    private dirty = false;
    private visible = false;

    constructor(private readonly opts: TerrainOptionsMenuOptions = {}) {
        this.profileId = opts.initialProfileId ?? DEFAULT_PROFILE_ID;
        this.container = document.createElement('div');
        this.container.style.cssText =
            'position:fixed;top:8px;right:8px;width:320px;z-index:50;max-height:92vh;overflow-y:auto;';
        document.body.appendChild(this.container);

        this.rebuild();

        const key = (opts.toggleKey ?? 'o').toLowerCase();
        window.addEventListener('keydown', (e) => {
            if (e.repeat || e.key.toLowerCase() !== key) return;
            if (this.isTypingTarget(e.target)) return;
            this.toggle();
        });
        this.setVisible(false);
    }

    /** Build (or rebuild, on profile switch) the whole pane from the schema. */
    private rebuild(): void {
        this.pane?.dispose();
        const label = PLANET_PROFILES[this.profileId]?.label ?? this.profileId;
        this.pane = new Pane({ container: this.container, title: `Terrain — ${label}` });
        // Working object: the fully resolved profile so every schema path is a real number.
        this.working = resolveEffectiveProfile(this.profileId) as unknown as Record<string, unknown>;

        // Profile selector.
        const sel = { profileId: this.profileId };
        const options: Record<string, string> = {};
        for (const id of PROFILE_IDS) options[PLANET_PROFILES[id]?.label ?? id] = id;
        this.pane.addBinding(sel, 'profileId', { label: 'Profile', options }).on('change', (ev) => {
            this.profileId = String(ev.value);
            this.rebuild();
        });

        // One folder per schema group, one slider per parameter.
        const folders = new Map<string, FolderApi>();
        for (const spec of TERRAIN_PARAM_SCHEMA) {
            let folder = folders.get(spec.group);
            if (!folder) {
                folder = this.pane.addFolder({ title: spec.group, expanded: spec.group === 'Relief' });
                folders.set(spec.group, folder);
            }
            const ref = this.leafRef(spec.path);
            if (typeof ref.obj[ref.key] !== 'number') continue;
            const binding = folder.addBinding(ref.obj as Record<string, number>, ref.key, {
                label: spec.label,
                min: spec.min,
                max: spec.max,
                step: spec.int ? Math.max(1, Math.round(spec.step)) : spec.step
            });
            (binding.element as HTMLElement).title = `${spec.description}${
                spec.kind === 'baked' ? '  [Apply to take effect]' : '  [live]'
            }`;
            binding.on('change', (ev) => this.onParamChange(spec.path, spec.kind, Number(ev.value)));
        }

        // Actions.
        const actions = this.pane.addFolder({ title: 'Actions', expanded: true });
        actions.addButton({ title: 'Apply changes' }).on('click', () => this.apply());
        actions.addButton({ title: 'Reset profile to defaults' }).on('click', () => this.resetProfile());
    }

    private onParamChange(path: string, kind: 'baked' | 'uniform', value: number): void {
        setOverride(this.profileId, path, value);
        if (kind === 'uniform' && this.opts.liveApply) {
            this.opts.liveApply(this.profileId, path, value);
        } else {
            this.dirty = true;
        }
    }

    private apply(): void {
        if (this.opts.onApply) this.opts.onApply(this.profileId);
        else if (typeof location !== 'undefined') location.reload();
        this.dirty = false;
    }

    private resetProfile(): void {
        clearProfileOverrides(this.profileId);
        this.rebuild(); // refresh the sliders back to the profile defaults
        this.apply(); // hot-rebuild (or reload) so the planet reflects the reset
    }

    /** Resolve a dotted path on the working object into its parent object + leaf key. */
    private leafRef(path: string): { obj: Record<string, unknown>; key: string } {
        const keys = path.split('.');
        let obj = this.working;
        for (let i = 0; i < keys.length - 1; i++) {
            const next = obj[keys[i]];
            if (next == null || typeof next !== 'object') obj[keys[i]] = {};
            obj = obj[keys[i]] as Record<string, unknown>;
        }
        return { obj, key: keys[keys.length - 1] };
    }

    private isTypingTarget(t: EventTarget | null): boolean {
        const el = t as HTMLElement | null;
        if (!el) return false;
        const tag = el.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable === true;
    }

    setVisible(v: boolean): void {
        this.visible = v;
        this.container.style.display = v ? 'block' : 'none';
    }

    toggle(): void {
        this.setVisible(!this.visible);
    }

    dispose(): void {
        this.pane?.dispose();
        this.container.remove();
    }
}
