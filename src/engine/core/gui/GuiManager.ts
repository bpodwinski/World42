import { Scene } from "@babylonjs/core";
import {
    AdvancedDynamicTexture,
    Rectangle,
    Control,
    TextBlock,
    Image
} from "@babylonjs/gui";
import { SpeedHUD } from "./components/SpeedHUD";
import { CenterCrosshair } from "./components/CenterCrosshair";
import { MouseCrosshair } from "./components/MouseCrosshair";

/**
 * Options for configuring GUI crosshairs
 */
export type CrosshairOpts = {
    /** Image path for the **center** crosshair */
    src?: string;

    /** Image path for the **mouse-following** crosshair */
    mouseSrc?: string;

    /** Pixel size (width/height) of the **center** crosshair */
    sizePx?: number;

    /** Pixel size (width/height) of the **mouse** crosshair */
    mouseSizePx?: number;

    /** Alpha when the **center** crosshair is inactive (0..1) */
    inactiveAlpha?: number;

    /** Alpha when the **center** crosshair is active (0..1) */
    activeAlpha?: number;

    /** Alpha of the **mouse** crosshair (0..1) */
    mouseAlpha?: number;
};

/**
 * GUI manager that renders:
 * - **center** crosshair anchored at the screen center
 * - **mouse** crosshair that visually replaces the system cursor inside the canvas
 *
 * It also exposes a small hint text overlay
 */
export class GuiManager {
    private ui: AdvancedDynamicTexture;

    private speedHud: SpeedHUD;
    private center: CenterCrosshair;
    private mouse: MouseCrosshair;

    private hintText: TextBlock;

    private opts: Required<CrosshairOpts>;

    /**
     * Creates a new GUI manager and builds the crosshair overlays
     * @param scene - The Babylon.js scene
     * @param opts  - Crosshair and UI configuration
     */
    constructor(scene: Scene, opts: CrosshairOpts = {}) {
        this.opts = {
            src: opts.src ?? "/assets/gui/crosshair_center.png",
            mouseSrc: opts.mouseSrc ?? "/assets/gui/crosshair_mouse.png",
            sizePx: opts.sizePx ?? 20,
            mouseSizePx: opts.mouseSizePx ?? 36,
            inactiveAlpha: opts.inactiveAlpha ?? 0.7,
            activeAlpha: opts.activeAlpha ?? 0.9,
            mouseAlpha: opts.mouseAlpha ?? 0.2,
        };

        this.ui = AdvancedDynamicTexture.CreateFullscreenUI("World42UI", true, scene);

        // Speed HUD
        this.speedHud = new SpeedHUD(this.ui, {
            topPx: 30,
            leftPx: 0,
            fontSize: 16,
            color: "white",
            outlineColor: "black",
            outlineWidth: 4,
        });

        // Crosshairs
        this.center = new CenterCrosshair(this.ui, {
            src: this.opts.src,
            sizePx: this.opts.sizePx,
            inactiveAlpha: this.opts.inactiveAlpha,
            activeAlpha: this.opts.activeAlpha,
        });

        this.mouse = new MouseCrosshair(this.ui, {
            src: this.opts.mouseSrc,
            sizePx: this.opts.mouseSizePx,
            alpha: this.opts.mouseAlpha,
        });

        // Hint (optional)
        this.hintText = new TextBlock("hint", "");
        this.hintText.color = "rgba(255,255,255,0.85)";
        this.hintText.fontSize = 14;
        this.hintText.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        this.hintText.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
        this.hintText.paddingLeft = 12;
        this.hintText.paddingBottom = 10;
        this.hintText.isPointerBlocker = false;
        this.ui.addControl(this.hintText);
    }

    /** Update the speed label (expects m/s) */
    public setSpeed(ms: number) {
        this.speedHud.set(ms);
    }

    // Center crosshair
    public setCrosshairVisible(visible: boolean) {
        this.center.setVisible(visible);
    }

    public setCrosshairActive(active: boolean) {
        this.center.setActive(active);
    }

    public setCrosshairSrc(src: string) {
        this.center.setSrc(src);
    }

    public setCrosshairSize(sizePx: number) {
        this.center.setSize(sizePx);
    }

    // Mouse crosshair
    public setMouseCrosshairVisible(visible: boolean) {
        this.mouse.setVisible(visible);
    }

    public setMouseCrosshairSrc(src: string) {
        this.mouse.setSrc(src);
    }

    public setMouseCrosshairSize(sizePx: number) {
        this.mouse.setSize(sizePx);
    }

    public updateMouseCrosshair(clientX: number, clientY: number, canvasRect: DOMRect) {
        this.mouse.updateClientPos(clientX, clientY, canvasRect);
    }

    /**
     * Sets the optional hint text displayed on screen
     * @param text - Hint content
     */
    public setHint(text: string) {
        this.hintText.text = text;
    }

    /**
     * Disposes the underlying AdvancedDynamicTexture and all UI controls
     */
    public dispose() {
        this.speedHud.dispose();
        this.center.dispose();
        this.mouse.dispose();
        this.ui.dispose();
    }
}
