import { Scene } from "@babylonjs/core";
import {
    AdvancedDynamicTexture,
    Rectangle,
    Control,
    TextBlock,
    Image
} from "@babylonjs/gui";

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

    /** Center crosshair container (fixed at screen center) */
    private crosshairContainer: Rectangle;

    /** Center crosshair image */
    private crosshairImg: Image;

    /** Mouse-following crosshair image */
    private mouseCrosshair: Image;

    /** Optional hint text displayed in the bottom-left corner */
    private hintText: TextBlock;

    private opts: Required<CrosshairOpts>;

    /**
     * Creates a new GUI manager and builds the crosshair overlays
     * @param scene - The Babylon.js scene
     * @param opts  - Crosshair and UI configuration
     */
    constructor(scene: Scene, opts: CrosshairOpts = {}) {
        this.opts = {
            src: opts.src ?? "/assets/ui/crosshair_center.png",
            mouseSrc: opts.mouseSrc ?? "/assets/ui/crosshair_mouse.png",
            sizePx: opts.sizePx ?? 20,
            mouseSizePx: opts.mouseSizePx ?? 36,
            inactiveAlpha: opts.inactiveAlpha ?? 0.7,
            activeAlpha: opts.activeAlpha ?? 0.9,
            mouseAlpha: opts.mouseAlpha ?? 0.2,
        };

        this.ui = AdvancedDynamicTexture.CreateFullscreenUI("World42UI", true, scene);

        // ----- Center crosshair (fixed) -----
        this.crosshairContainer = new Rectangle("crosshair_center");
        this.crosshairContainer.width = `${this.opts.sizePx}px`;
        this.crosshairContainer.height = `${this.opts.sizePx}px`;
        this.crosshairContainer.thickness = 0;
        this.crosshairContainer.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
        this.crosshairContainer.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
        this.crosshairContainer.isPointerBlocker = false;
        this.crosshairContainer.alpha = this.opts.inactiveAlpha;
        this.ui.addControl(this.crosshairContainer);

        this.crosshairImg = new Image("crosshair_center_img", this.opts.src);
        this.crosshairImg.stretch = Image.STRETCH_UNIFORM;
        this.crosshairImg.width = "100%";
        this.crosshairImg.height = "100%";
        this.crosshairImg.isPointerBlocker = false;
        this.crosshairContainer.addControl(this.crosshairImg);

        // ----- Mouse crosshair (follows pointer) -----
        this.mouseCrosshair = new Image("crosshair_mouse", this.opts.mouseSrc);
        this.mouseCrosshair.stretch = Image.STRETCH_UNIFORM;
        this.mouseCrosshair.width = `${this.opts.mouseSizePx}px`;
        this.mouseCrosshair.height = `${this.opts.mouseSizePx}px`;
        this.mouseCrosshair.isPointerBlocker = false;
        this.mouseCrosshair.alpha = this.opts.mouseAlpha;

        // Important: align top-left; we position via pixel left/top
        this.mouseCrosshair.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        this.mouseCrosshair.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        this.mouseCrosshair.left = "-1000px"; // off-screen initially
        this.mouseCrosshair.top = "-1000px";
        this.ui.addControl(this.mouseCrosshair);

        // ----- Optional hint -----
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

    /**
     * Shows or hides the **center** crosshair
     * @param visible - Whether the center crosshair should be visible
     */
    public setCrosshairVisible(visible: boolean) {
        this.crosshairContainer.isVisible = visible;
    }

    /**
     * Sets the **center** crosshair alpha to active/inactive state
     * @param active - If true, uses `activeAlpha`; otherwise `inactiveAlpha`
     */
    public setCrosshairActive(active: boolean) {
        this.crosshairContainer.alpha = active ? this.opts.activeAlpha : this.opts.inactiveAlpha;
    }

    /**
     * Changes the **center** crosshair image at runtime
     * @param src - New image URL
     */
    public setCrosshairSrc(src: string) {
        this.crosshairImg.source = src;
    }

    /**
     * Changes the **center** crosshair size at runtime
     * @param sizePx - New pixel size (width/height)
     */
    public setCrosshairSize(sizePx: number) {
        this.crosshairContainer.width = `${sizePx}px`;
        this.crosshairContainer.height = `${sizePx}px`;
    }

    /**
     * Shows or hides the **mouse** crosshair
     * @param visible - Whether the mouse crosshair should be visible
     */
    public setMouseCrosshairVisible(visible: boolean) {
        this.mouseCrosshair.isVisible = visible;
    }

    /**
     * Changes the **mouse** crosshair image at runtime
     * @param src - New image URL
     */
    public setMouseCrosshairSrc(src: string) {
        this.mouseCrosshair.source = src;
    }

    /**
     * Changes the **mouse** crosshair size at runtime
     * @param sizePx - New pixel size (width/height)
     */
    public setMouseCrosshairSize(sizePx: number) {
        this.mouseCrosshair.width = `${sizePx}px`;
        this.mouseCrosshair.height = `${sizePx}px`;
    }

    /**
     * Updates the **mouse** crosshair position using client coordinates
     * (e.g., `PointerEvent.clientX/clientY`) and the canvas DOMRect, the image is auto-centered under the pointer
     *
     * @param clientX - Pointer X in client coordinates
     * @param clientY - Pointer Y in client coordinates
     * @param canvasRect - Canvas bounding rect (from `getBoundingClientRect()`)
     */
    public updateMouseCrosshair(clientX: number, clientY: number, canvasRect: DOMRect) {
        const x = clientX - canvasRect.left - (this.mouseCrosshair.widthInPixels ?? this.opts.mouseSizePx) / 2;
        const y = clientY - canvasRect.top - (this.mouseCrosshair.heightInPixels ?? this.opts.mouseSizePx) / 2;
        this.mouseCrosshair.left = `${x}px`;
        this.mouseCrosshair.top = `${y}px`;
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
        this.ui.dispose();
    }
}
