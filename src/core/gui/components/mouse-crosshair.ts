// mouse-crosshair.ts
import { Image, Control, AdvancedDynamicTexture } from "@babylonjs/gui";

/**
 * Options to configure the mouse-following crosshair
 */
export type MouseCrosshairOpts = {
    /** Texture URL used when the crosshair is idle (no LMB held) */
    idleSrc: string;

    /**
     * Texture URL used while the left mouse button (LMB) is held. Falls back to {@link MouseCrosshairOpts.idleSrc} if not provided
     */
    activeSrc?: string;

    /**
     * Crosshair size (width & height in pixels) while idle
     * @defaultValue 24
     */
    sizePx?: number;

    /**
     * Crosshair size (width & height in pixels) while active (LMB held). Falls back to {@link MouseCrosshairOpts.sizePx} if not provided
     */
    activeSizePx?: number;

    /**
     * Crosshair alpha while idle
     * @defaultValue 1
     */
    idleAlpha?: number;

    /**
     * Crosshair alpha while active (LMB held)
     * Falls back to {@link MouseCrosshairOpts.idleAlpha} if not provided
     */
    activeAlpha?: number;
};

/**
 * GUI crosshair that follows the mouse inside the canvas. It can switch appearance (texture/size/alpha) when the LMB is held
 */
export class MouseCrosshair {
    private ui: AdvancedDynamicTexture;
    private img: Image;

    private idleSrc: string;
    private activeSrc: string;

    private idleSize: number;
    private activeSize: number;

    private idleAlpha: number;
    private activeAlpha: number;

    private _active = false;

    /**
     * Creates a mouse-following crosshair
     *
     * @param ui - The fullscreen UI to attach the crosshair to
     * @param opts - Crosshair configuration options
     */
    constructor(ui: AdvancedDynamicTexture, opts: MouseCrosshairOpts) {
        this.ui = ui;

        this.idleSrc = opts.idleSrc;
        this.activeSrc = opts.activeSrc ?? opts.idleSrc;

        this.idleSize = opts.sizePx ?? 24;
        this.activeSize = opts.activeSizePx ?? this.idleSize;

        this.idleAlpha = opts.idleAlpha ?? 1;
        this.activeAlpha = opts.activeAlpha ?? this.idleAlpha;

        this.img = new Image("mouseCrosshair", this.idleSrc);
        this.img.width = this.idleSize + "px";
        this.img.height = this.idleSize + "px";
        this.img.alpha = this.idleAlpha;
        this.img.isPointerBlocker = false;
        this.img.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        this.img.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;

        this.ui.addControl(this.img);
    }

    /**
     * Moves the crosshair to the given client coordinates (in pixels)
     *
     * @param clientX - Mouse client X
     * @param clientY - Mouse client Y
     * @param rect - The canvas bounding client rect used for offsetting
     */
    updatePosition(clientX: number, clientY: number, rect: DOMRect): void {
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        this.img.left = x + "px";
        this.img.top = y + "px";
    }

    /**
     * Backward-compatible alias for {@link updatePosition}. Some call sites may still reference `updateClientPos`
     *
     * @param clientX - Mouse client X
     * @param clientY - Mouse client Y
     * @param rect - The canvas bounding client rect used for offsetting
     */
    updateClientPos(clientX: number, clientY: number, rect: DOMRect): void {
        this.updatePosition(clientX, clientY, rect);
    }

    /**
     * Toggles the "active" visual state (used while LMB is held). This swaps texture, size, and alpha according to the configured active/idle values
     *
     * @param active - `true` to enable the active state; `false` to return to idle
     */
    setActive(active: boolean): void {
        if (this._active === active) return;
        this._active = active;

        if (active) {
            this.img.source = this.activeSrc;
            this.img.width = this.activeSize + "px";
            this.img.height = this.activeSize + "px";
            this.img.alpha = this.activeAlpha;
        } else {
            this.img.source = this.idleSrc;
            this.img.width = this.idleSize + "px";
            this.img.height = this.idleSize + "px";
            this.img.alpha = this.idleAlpha;
        }
    }

    /**
     * Sets the GUI visibility of the crosshair
     * @remarks Leave it always visible if you only switch skins on LMB
     *
     * @param visible - Whether the control should be visible
     */
    setVisible(visible: boolean): void {
        this.img.isVisible = visible;
    }

    /**
     * Changes the idle texture source. Optionally also updates the active texture to keep them in sync
     *
     * @param src - New idle texture URL
     * @param alsoActive - Also apply the same source to the active texture. Defaults to `true`
     */
    setSrc(src: string, alsoActive = true): void {
        this.idleSrc = src;
        if (!this._active) this.img.source = src;
        if (alsoActive) this.activeSrc = src;
    }

    /**
     * Changes the idle size (in pixels). Does not affect the active size
     *
     * @param sizePx - New width/height in pixels for the idle state
     */
    setSize(sizePx: number): void {
        this.idleSize = sizePx;
        if (!this._active) {
            this.img.width = sizePx + "px";
            this.img.height = sizePx + "px";
        }
    }

    /**
     * Disposes the underlying GUI control
     */
    dispose(): void {
        this.img?.dispose();
    }
}
