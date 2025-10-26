import { AdvancedDynamicTexture, Control, TextBlock } from "@babylonjs/gui";

/**
 * Configuration options for the Speed HUD overlay
 */
export type SpeedHUDOpts = {
    /** Vertical offset from the top edge in pixels */
    topPx?: number;

    /** Horizontal offset from the left edge in pixels */
    leftPx?: number;

    /** Font size for the speed text */
    fontSize?: number;

    /** Text color */
    color?: string;

    /** Outline color of the text */
    outlineColor?: string;

    /** Outline thickness of the text */
    outlineWidth?: number;

    /** Optional custom formatter that receives speed in m/s and returns a formatted string */
    formatter?: (ms: number) => string;
};

/**
 * SpeedHUD displays the current velocity (in m/s) on an existing AdvancedDynamicTexture. It does **not** create a new ADT instance — it attaches to one provided by the caller
 */
export class SpeedHUD {
    private text: TextBlock;
    private fmt: (ms: number) => string;

    /**
     * Creates a new SpeedHUD component and attaches it to the given UI
     * @param ui - The AdvancedDynamicTexture to attach the HUD to
     * @param opts - Optional configuration for position, style, and formatting
     */
    constructor(ui: AdvancedDynamicTexture, opts: SpeedHUDOpts = {}) {
        const {
            topPx = 30,
            leftPx = 0,
            fontSize = 16,
            color = "white",
            outlineColor = "black",
            outlineWidth = 4,
            formatter,
        } = opts;

        this.fmt = formatter ?? ((ms) => `${Math.round(ms)} m/s`);

        this.text = new TextBlock("speed_hud");
        this.text.text = this.fmt(0);
        this.text.fontSize = fontSize;
        this.text.color = color;
        this.text.outlineColor = outlineColor;
        this.text.outlineWidth = outlineWidth;
        this.text.top = `${topPx}px`;
        this.text.left = `${leftPx}px`;
        this.text.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
        this.text.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;

        ui.addControl(this.text);
    }

    /** Updates the displayed speed (expects meters per second) */
    public set(ms: number) {
        this.text.text = this.fmt(ms);
    }

    /** Shows or hides the speed HUD */
    public setVisible(visible: boolean) {
        this.text.isVisible = visible;
    }

    /** Changes the speed text formatter at runtime (e.g., m/s → km/h) */
    public setFormatter(formatter: (ms: number) => string) {
        this.fmt = formatter;
    }

    /** Disposes of the underlying TextBlock */
    public dispose() {
        this.text.dispose();
    }
}
