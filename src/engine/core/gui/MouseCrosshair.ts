import { AdvancedDynamicTexture, Control, Image } from "@babylonjs/gui";

export type MouseCrosshairOpts = {
    /** Image URL for the mouse-following crosshair */
    src?: string;

    /** Square size in pixels */
    sizePx?: number;

    /** Alpha (0..1) */
    alpha?: number;
};

export class MouseCrosshair {
    private img: Image;
    private defaultSize: number;

    constructor(ui: AdvancedDynamicTexture, opts: MouseCrosshairOpts = {}) {
        const {
            src = "/assets/ui/crosshair_mouse.png",
            sizePx = 36,
            alpha = 0.2,
        } = opts;

        this.defaultSize = sizePx;

        this.img = new Image("crosshair_mouse", src);
        this.img.stretch = Image.STRETCH_UNIFORM;
        this.img.width = `${sizePx}px`;
        this.img.height = `${sizePx}px`;
        this.img.isPointerBlocker = false;
        this.img.alpha = alpha;

        // Top-left anchoring; we position with pixel left/top
        this.img.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        this.img.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        this.img.left = "-1000px"; // off-screen initially
        this.img.top = "-1000px";
        ui.addControl(this.img);
    }

    /** Show/hide the mouse crosshair */
    public setVisible(visible: boolean) {
        this.img.isVisible = visible;
    }

    /** Change the image URL */
    public setSrc(src: string) {
        this.img.source = src;
    }

    /** Change size (square) in pixels */
    public setSize(sizePx: number) {
        this.img.width = `${sizePx}px`;
        this.img.height = `${sizePx}px`;
        this.defaultSize = sizePx;
    }

    /**
     * Update position using client coordinates and canvas rect, the image is auto-centered under the pointer
     */
    public updateClientPos(clientX: number, clientY: number, canvasRect: DOMRect) {
        const w = this.img.widthInPixels ?? this.defaultSize;
        const h = this.img.heightInPixels ?? this.defaultSize;
        const x = clientX - canvasRect.left - w / 2;
        const y = clientY - canvasRect.top - h / 2;
        this.img.left = `${x}px`;
        this.img.top = `${y}px`;
    }

    public dispose() {
        this.img.dispose();
    }
}
