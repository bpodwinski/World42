import { AdvancedDynamicTexture, Control, Image, Rectangle } from "@babylonjs/gui";

export type CenterCrosshairOpts = {
    /** Image URL for the center crosshair */
    src?: string;

    /** Square size in pixels */
    sizePx?: number;

    /** Alpha when inactive (0..1) */
    inactiveAlpha?: number;

    /** Alpha when active (0..1) */
    activeAlpha?: number;
};

export class CenterCrosshair {
    private container: Rectangle;
    private img: Image;
    private inactiveAlpha: number;
    private activeAlpha: number;

    constructor(ui: AdvancedDynamicTexture, opts: CenterCrosshairOpts = {}) {
        const {
            src = "/assets/ui/crosshair_center.png",
            sizePx = 20,
            inactiveAlpha = 0.7,
            activeAlpha = 0.9,
        } = opts;

        this.inactiveAlpha = inactiveAlpha;
        this.activeAlpha = activeAlpha;

        this.container = new Rectangle("crosshair_center");
        this.container.width = `${sizePx}px`;
        this.container.height = `${sizePx}px`;
        this.container.thickness = 0;
        this.container.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
        this.container.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
        this.container.isPointerBlocker = false;
        this.container.alpha = this.inactiveAlpha;
        ui.addControl(this.container);

        this.img = new Image("crosshair_center_img", src);
        this.img.stretch = Image.STRETCH_UNIFORM;
        this.img.width = "100%";
        this.img.height = "100%";
        this.img.isPointerBlocker = false;
        this.container.addControl(this.img);
    }

    /** Show/hide the center crosshair */
    public setVisible(visible: boolean) {
        this.container.isVisible = visible;
    }

    /** Switch between active/inactive alpha */
    public setActive(active: boolean) {
        this.container.alpha = active ? this.activeAlpha : this.inactiveAlpha;
    }

    /** Change the image URL */
    public setSrc(src: string) {
        this.img.source = src;
    }

    /** Change size (square) in pixels */
    public setSize(sizePx: number) {
        this.container.width = `${sizePx}px`;
        this.container.height = `${sizePx}px`;
    }

    public dispose() {
        this.container.dispose();
    }
}
