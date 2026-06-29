import { AdvancedDynamicTexture, Control, TextBlock } from "@babylonjs/gui";

/**
 * Configuration options for the Performance HUD overlay.
 */
export type PerfHUDOpts = {
    /** Vertical offset from the top edge in pixels */
    topPx?: number;
    /** Horizontal offset from the left edge in pixels */
    leftPx?: number;
    /** Font size for the stats text */
    fontSize?: number;
    /** Text color */
    color?: string;
    /** Outline color of the text */
    outlineColor?: string;
    /** Outline thickness of the text */
    outlineWidth?: number;
};

/**
 * PerfHUD displays a multi-line performance read-out (frame/GPU time, draw
 * calls, TERRAIN leaf/split/merge counts, rebuild ms) in the top-right corner.
 *
 * It attaches to an existing AdvancedDynamicTexture and is **hidden by default**
 * so normal runs are unaffected — toggle it with {@link setVisible}.
 */
export class PerfHUD {
    private text: TextBlock;
    private visible = false;

    constructor(ui: AdvancedDynamicTexture, opts: PerfHUDOpts = {}) {
        const {
            topPx = 60,
            leftPx = 12,
            fontSize = 18,
            color = "#9effa0",
            outlineColor = "black",
            outlineWidth = 4,
        } = opts;

        this.text = new TextBlock("perf_hud");
        this.text.text = "";
        this.text.fontFamily = "monospace";
        this.text.fontSize = fontSize;
        this.text.color = color;
        this.text.outlineColor = outlineColor;
        this.text.outlineWidth = outlineWidth;
        this.text.top = `${topPx}px`;
        this.text.paddingLeft = `${leftPx}px`;
        this.text.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        this.text.textVerticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        this.text.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        this.text.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
        this.text.resizeToFit = true;
        this.text.isPointerBlocker = false;
        this.text.isVisible = false;

        ui.addControl(this.text);
    }

    /** Replaces the displayed text (caller formats the multi-line string). */
    public set(text: string) {
        this.text.text = text;
    }

    public setVisible(visible: boolean) {
        this.visible = visible;
        this.text.isVisible = visible;
    }

    public toggle(): boolean {
        this.setVisible(!this.visible);
        return this.visible;
    }

    public isVisible(): boolean {
        return this.visible;
    }

    public dispose() {
        this.text.dispose();
    }
}
