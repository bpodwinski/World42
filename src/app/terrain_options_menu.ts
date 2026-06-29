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
import { TERRAIN_PARAM_SCHEMA, type ParamSpec } from '../game_world/stellar_system/terrain_param_schema';
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
    /**
     * Global render-pipeline settings (NOT part of the per-profile terrain schema). When supplied, a
     * "Render" folder exposes the FSR1 internal render scale; changes apply live (graph rebuild).
     */
    renderSettings?: {
        /** Current FSR1 render scale (0.5..1); the menu keeps this in sync as the user drags. */
        fsr1RenderScale: number;
        /** Apply a new FSR1 render scale live. */
        onFsr1RenderScaleChange: (scale: number) => void;
    };
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

        // One folder per schema group; widget kind chosen per parameter.
        const folders = new Map<string, FolderApi>();
        const getFolder = (group: string): FolderApi => {
            let f = folders.get(group);
            if (!f) {
                f = this.pane.addFolder({ title: group, expanded: group === 'Relief' });
                folders.set(group, f);
            }
            return f;
        };
        for (const spec of TERRAIN_PARAM_SCHEMA) {
            const folder = getFolder(spec.group);
            const control = spec.control ?? 'slider';
            if (control === 'color') this.addColorParam(folder, spec);
            else if (control === 'vec3') this.addVec3Param(folder, spec);
            else this.addSliderParam(folder, spec);
        }

        // Per-class crater editor (count + cell/radius/depth/density per class).
        this.addCraterClassesFolder(getFolder('Crater classes'));

        // Global render-pipeline settings (independent of the selected terrain profile).
        if (this.opts.renderSettings) this.addRenderFolder();

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

    private tooltip(spec: ParamSpec, el: HTMLElement): void {
        el.title = `${spec.description}${spec.kind === 'baked' ? '  [Apply to take effect]' : '  [live]'}`;
    }

    /** Single numeric slider bound directly to the working object at spec.path. */
    private addSliderParam(folder: FolderApi, spec: ParamSpec): void {
        const ref = this.leafRef(spec.path);
        if (typeof ref.obj[ref.key] !== 'number') return;
        const binding = folder.addBinding(ref.obj as Record<string, number>, ref.key, {
            label: spec.label,
            min: spec.min,
            max: spec.max,
            step: spec.int ? Math.max(1, Math.round(spec.step)) : spec.step
        });
        this.tooltip(spec, binding.element as HTMLElement);
        binding.on('change', (ev) => this.onParamChange(spec.path, spec.kind, Number(ev.value)));
    }

    /** RGB color picker (float 0..1) bound to a [r,g,b] array at spec.path. */
    private addColorParam(folder: FolderApi, spec: ParamSpec): void {
        const arr = this.getArr(spec.path);
        if (!arr) return;
        const proxy = { c: { r: arr[0] ?? 0, g: arr[1] ?? 0, b: arr[2] ?? 0 } };
        const binding = folder.addBinding(proxy, 'c', { label: spec.label, color: { type: 'float' } });
        this.tooltip(spec, binding.element as HTMLElement);
        binding.on('change', (ev) => {
            const v = ev.value as { r: number; g: number; b: number };
            this.commitArr(spec.path, [v.r, v.g, v.b]);
        });
    }

    /** Three component sliders bound to a [x,y,z] array at spec.path (e.g. highland tint). */
    private addVec3Param(folder: FolderApi, spec: ParamSpec): void {
        const arr = this.getArr(spec.path);
        if (!arr) return;
        const sub = folder.addFolder({ title: spec.label, expanded: false });
        const proxy: Record<string, number> = { x: arr[0] ?? 0, y: arr[1] ?? 0, z: arr[2] ?? 0 };
        const comps: Array<{ key: string; label: string }> = [
            { key: 'x', label: 'R' },
            { key: 'y', label: 'G' },
            { key: 'z', label: 'B' }
        ];
        for (const c of comps) {
            const binding = sub.addBinding(proxy, c.key, {
                label: c.label,
                min: spec.min,
                max: spec.max,
                step: spec.step
            });
            this.tooltip(spec, binding.element as HTMLElement);
            binding.on('change', () => this.commitArr(spec.path, [proxy.x, proxy.y, proxy.z]));
        }
    }

    /** Crater-classes editor: a count control + one sub-folder of 4 sliders per class. */
    private addCraterClassesFolder(folder: FolderApi): void {
        const craters = this.working.craters as { classes?: number[][] } | undefined;
        const classes = Array.isArray(craters?.classes) ? (craters!.classes as number[][]) : [];

        const countProxy = { count: classes.length };
        folder
            .addBinding(countProxy, 'count', { label: 'Classes', min: 1, max: 8, step: 1 })
            .on('change', (ev) => {
                const n = Math.max(1, Math.min(8, Math.round(Number(ev.value))));
                const cur = classes.map((c) => [...c]);
                while (cur.length < n) cur.push([...(cur[cur.length - 1] ?? [20, 0.2, 1, 0.6])]);
                while (cur.length > n) cur.pop();
                (this.working.craters as { classes: number[][] }).classes = cur;
                setOverride(this.profileId, 'craters.classes', cur.map((c) => [...c]));
                this.dirty = true;
                this.rebuild(); // refresh the per-class sub-folders for the new count
            });

        const fields: Array<{ i: number; label: string; min: number; max: number; step: number }> = [
            { i: 0, label: 'Cell (km)', min: 1, max: 2000, step: 1 },
            { i: 1, label: 'Radius frac', min: 0.05, max: 0.4, step: 0.01 },
            { i: 2, label: 'Depth (km)', min: 0, max: 30, step: 0.1 },
            { i: 3, label: 'Density', min: 0, max: 1, step: 0.01 }
        ];
        classes.forEach((cls, idx) => {
            const sub = folder.addFolder({ title: `Class ${idx} (largest first)`, expanded: false });
            const proxy: Record<string, number> = { f0: cls[0], f1: cls[1], f2: cls[2], f3: cls[3] };
            for (const f of fields) {
                sub.addBinding(proxy, `f${f.i}`, {
                    label: f.label,
                    min: f.min,
                    max: f.max,
                    step: f.step
                }).on('change', () => {
                    cls[0] = proxy.f0;
                    cls[1] = proxy.f1;
                    cls[2] = proxy.f2;
                    cls[3] = proxy.f3;
                    setOverride(this.profileId, 'craters.classes', classes.map((c) => [...c]));
                    this.dirty = true;
                });
            }
        });
    }

    /** Global render settings folder: FSR1 internal render scale (applies live via a graph rebuild). */
    private addRenderFolder(): void {
        const rs = this.opts.renderSettings;
        if (!rs) return;
        const folder = this.pane.addFolder({ title: 'Render', expanded: false });
        const proxy = { fsr1: rs.fsr1RenderScale };
        const binding = folder.addBinding(proxy, 'fsr1', {
            label: 'FSR1 render scale',
            min: 0.5,
            max: 1,
            step: 0.05
        });
        (binding.element as HTMLElement).title =
            'Fraction of the backbuffer the scene is shaded at, then upscaled (EASU+RCAS). ' +
            'Lower = faster, softer. 1 = native. Applies live (rebuilds the frame graph).  [live]';
        binding.on('change', (ev) => {
            const v = Number(ev.value);
            rs.fsr1RenderScale = v; // keep in sync so a profile-switch rebuild restores the value
            rs.onFsr1RenderScaleChange(v);
        });
    }

    /** Read a number[] at a dotted path on the working object (or null if not an array). */
    private getArr(path: string): number[] | null {
        const ref = this.leafRef(path);
        const v = ref.obj[ref.key];
        return Array.isArray(v) ? (v as number[]) : null;
    }

    /** Write an array into the working object at path, persist it, and mark a rebuild pending. */
    private commitArr(path: string, arr: number[]): void {
        const ref = this.leafRef(path);
        ref.obj[ref.key] = arr;
        setOverride(this.profileId, path, arr);
        this.dirty = true;
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
