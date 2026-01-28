/**
 * Type defining the UV bounds of a terrain chunk (on a cube face)
 */
export type Bounds = {
    uMin: number;
    uMax: number;
    vMin: number;
    vMax: number;
};

/**
 * Type defining the possible cube faces (quadsphere)
 */
export type Face = "front" | "back" | "left" | "right" | "top" | "bottom";
