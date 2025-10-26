import { Scene, Vector3, Quaternion, KeyboardEventTypes } from "@babylonjs/core";
import { OriginCamera } from "./CameraManager";

/**
 * Configuration options for the space flight mouse-steer controller
 */
export type SpaceFlightOpts = {
    /** Dead zone radius (in pixels) around the screen center where mouse has no effect */
    deadzonePx?: number;

    /** Effective radius (in pixels) used to normalize mouse offset [deadzone..maxRadius] */
    maxRadiusPx?: number;

    /** Response curve exponent (>1 gives finer control near center) */
    responseCurve?: number;

    /** Maximum yaw rate in radians per second (left/right) */
    maxYawRate?: number;

    /** Maximum pitch rate in radians per second (up/down) */
    maxPitchRate?: number;

    /** Invert vertical mouse steering (airplane-style) */
    invertY?: boolean;

    /** Base forward/backward acceleration in m/s^2 */
    acceleration?: number;

    /** Lateral/vertical acceleration in m/s^2 */
    strafeAcceleration?: number;

    /** Maximum linear speed in m/s */
    maxSpeed?: number;

    /** Exponential damping factor (0..1) applied each frame */
    damping?: number;

    /** Speed multiplier when boost is held (Shift) */
    boostMultiplier?: number;

    /** Stronger damping when braking (Ctrl) */
    brakeDamping?: number;
};

/**
 * MouseSteerControlManager implements **mouse steering** for a 6DOF spacecraft camera:
 * - Mouse controls **yaw/pitch** based on cursor offset from screen center.
 * - Roll and translation are **keyboard** driven (Z/S, Q/D, R/F, E/A, Shift/Ctrl).
 * - Movement is applied to `OriginCamera.doublepos` (floating-origin friendly).
 *
 * This controller does **not** bind pointer-lock; it reads absolute mouse position in the canvas.
 */
export class MouseSteerControlManager {
    private camera: OriginCamera;
    private scene: Scene;
    private canvas: HTMLCanvasElement;

    /** World-space (double) linear velocity integrated each frame. */
    private velocity = new Vector3();

    /** Keyboard inputs state (ZQSD/RF + roll + boost/brake). */
    private inputs = { fwd: 0, strafe: 0, rise: 0, rollLeft: 0, rollRight: 0, boost: 0, brake: 0 };

    private mouseX = 0;
    private mouseY = 0;
    private rect?: DOMRect;

    private opts: Required<SpaceFlightOpts>;
    private beforeRenderObserver?: any;

    private mouseOverCanvas = false;
    private mouseActiveInWindow = true;

    /**
     * Creates a new MouseSteerControlManager controller
     * @param camera    OriginCamera to control (must use rotationQuaternion, not target)
     * @param scene     Babylon.js scene
     * @param canvas    Rendering canvas (used to read absolute mouse position)
     * @param opts      Optional configuration overrides
     */
    constructor(camera: OriginCamera, scene: Scene, canvas: HTMLCanvasElement, opts: SpaceFlightOpts = {}) {
        this.camera = camera;
        this.scene = scene;
        this.canvas = canvas;

        this.opts = {
            deadzonePx: opts.deadzonePx ?? 50,
            maxRadiusPx: opts.maxRadiusPx ?? 500,
            responseCurve: opts.responseCurve ?? 1.0,
            maxYawRate: opts.maxYawRate ?? 0.75,
            maxPitchRate: opts.maxPitchRate ?? 0.75,
            invertY: opts.invertY ?? false,
            acceleration: opts.acceleration ?? 20,
            strafeAcceleration: opts.strafeAcceleration ?? 20,
            maxSpeed: opts.maxSpeed ?? 1000,
            damping: opts.damping ?? 0.1,
            boostMultiplier: opts.boostMultiplier ?? 4,
            brakeDamping: opts.brakeDamping ?? 0.35,
        };

        // Ensure we rotate with quaternions (never use setTarget for 6DOF)
        if (!this.camera.rotationQuaternion) this.camera.rotationQuaternion = Quaternion.Identity();

        this.bindInputs();
        this.beforeRenderObserver = this.scene.onBeforeRenderObservable.add(this.update);
    }

    /**
     * Disposes the controller, removing event listeners and the frame observer
     */
    public dispose(): void {
        this.unbindInputs();

        if (this.beforeRenderObserver) {
            this.scene.onBeforeRenderObservable.remove(this.beforeRenderObserver);
            this.beforeRenderObserver = undefined;
        }
    }

    /**
     * Registers input listeners for mouse (absolute position) and keyboard
     */
    private bindInputs(): void {
        const updateRect = () => { this.rect = this.canvas.getBoundingClientRect(); };
        const centerMouse = () => {
            if (!this.rect) updateRect();
            const r = this.rect!;
            this.mouseX = r.width * 0.5;
            this.mouseY = r.height * 0.5;
        };

        const onMouseEnterCanvas = () => { this.mouseOverCanvas = true; };
        const onMouseLeaveCanvas = () => { this.mouseOverCanvas = false; };

        // Track mouse position in the canvas (absolute, not relative deltas)
        const onMouseMove = (e: MouseEvent) => {
            if (!this.rect) updateRect();

            const r = this.rect!;
            if (!this.mouseOverCanvas) return;
            this.mouseX = e.clientX - r.left;
            this.mouseY = e.clientY - r.top;
        };

        const onResize = () => {
            updateRect();
            centerMouse();
        };

        const onWindowFocus = () => { this.mouseActiveInWindow = true; };
        const onWindowBlur = () => { this.mouseActiveInWindow = false; centerMouse(); };

        const onWindowMouseOut = (e: MouseEvent) => {
            if (!e.relatedTarget && !(e as any).toElement) {
                this.mouseActiveInWindow = false;
                centerMouse();
            }
        };

        const onVisibilityChange = () => {
            this.mouseActiveInWindow = !document.hidden && document.hasFocus();
            if (!this.mouseActiveInWindow) centerMouse();
        };

        // Listeners
        window.addEventListener("mousemove", onMouseMove, { passive: true });
        window.addEventListener("resize", onResize);

        window.addEventListener("focus", onWindowFocus);
        window.addEventListener("blur", onWindowBlur);
        window.addEventListener("mouseout", onWindowMouseOut);
        document.addEventListener("visibilitychange", onVisibilityChange);

        this.canvas.addEventListener("mouseenter", onMouseEnterCanvas);
        this.canvas.addEventListener("mouseleave", onMouseLeaveCanvas);

        this.rect = this.canvas.getBoundingClientRect();
        centerMouse();

        this.scene.onKeyboardObservable.add(kb => {
            if (kb.type !== KeyboardEventTypes.KEYDOWN && kb.type !== KeyboardEventTypes.KEYUP) return;
            const down = kb.type === KeyboardEventTypes.KEYDOWN;
            const k = kb.event.key.toLowerCase();

            if (k === "z") this.inputs.fwd = down ? 1 : (this.inputs.fwd === 1 ? 0 : this.inputs.fwd);
            if (k === "s") this.inputs.fwd = down ? -1 : (this.inputs.fwd === -1 ? 0 : this.inputs.fwd);
            if (k === "q") this.inputs.strafe = down ? -1 : (this.inputs.strafe === -1 ? 0 : this.inputs.strafe);
            if (k === "d") this.inputs.strafe = down ? 1 : (this.inputs.strafe === 1 ? 0 : this.inputs.strafe);
            if (k === "r") this.inputs.rise = down ? 1 : (this.inputs.rise === 1 ? 0 : this.inputs.rise);
            if (k === "f") this.inputs.rise = down ? -1 : (this.inputs.rise === -1 ? 0 : this.inputs.rise);

            if (k === "e") this.inputs.rollLeft = down ? 1 : 0;
            if (k === "a") this.inputs.rollRight = down ? 1 : 0;

            if (k === "shift") this.inputs.boost = down ? 1 : 0;
            if (k === "control") this.inputs.brake = down ? 1 : 0;
        });

        (this as any)._listeners = {
            onMouseMove, onResize,
            onWindowFocus, onWindowBlur, onWindowMouseOut, onVisibilityChange,
            onMouseEnterCanvas, onMouseLeaveCanvas
        };
    }

    /**
     * Unregisters input listeners
     */
    private unbindInputs(): void {
        const L = (this as any)._listeners;
        if (!L) return;

        window.removeEventListener("mousemove", L.onMouseMove);
        window.removeEventListener("resize", L.onResize);
        window.removeEventListener("focus", L.onWindowFocus);
        window.removeEventListener("blur", L.onWindowBlur);
        window.removeEventListener("mouseout", L.onWindowMouseOut);
        document.removeEventListener("visibilitychange", L.onVisibilityChange);

        this.canvas.removeEventListener("mouseenter", L.onMouseEnterCanvas);
        this.canvas.removeEventListener("mouseleave", L.onMouseLeaveCanvas);
    }

    /**
     * Per-frame update: computes yaw/pitch from mouse offset, roll/translation from keyboard integrates velocity, and applies floating-origin movement via `doublepos`
     */
    private update = (): void => {
        const dt = this.scene.getEngine().getDeltaTime() * 0.001;
        if (dt <= 0 || !this.rect) return;

        const steerEnabled = this.mouseActiveInWindow && this.mouseOverCanvas;

        // 1) Cursor offset from screen center (maps to yaw/pitch)
        let ax = 0, ay = 0;

        if (steerEnabled) {
            const cx = this.rect.width * 0.5;
            const cy = this.rect.height * 0.5;
            let dx = this.mouseX - cx;
            let dy = this.mouseY - cy;

            if (this.opts.invertY) dy = -dy;

            const mag = Math.hypot(dx, dy);
            const dz = this.opts.deadzonePx;
            const R = this.opts.maxRadiusPx;

            if (mag > dz) {
                const clipped = Math.min(mag, R);
                const radiusNorm = (clipped - dz) / (R - dz); // 0..1

                const k = Math.pow(radiusNorm, this.opts.responseCurve); // response shaping
                const nx = dx / mag, ny = dy / mag; // unit direction

                ax = nx * k; // horizontal deflection (-1..1)
                ay = ny * k; // vertical deflection (-1..1)
            }
        }

        // 2) Angular velocity from mouse deflection (yaw/pitch)
        const yawRate = this.opts.maxYawRate * ax;
        const pitchRate = this.opts.maxPitchRate * ay;

        if (yawRate || pitchRate) {
            const right = this.camera.getDirection(Vector3.Right());
            const up = this.camera.getDirection(Vector3.Up());
            const qYaw = Quaternion.RotationAxis(up, yawRate * dt);
            const qPitch = Quaternion.RotationAxis(right, pitchRate * dt);
            this.camera.rotationQuaternion = qPitch.multiply(qYaw).multiply(this.camera.rotationQuaternion!);
            this.camera.rotationQuaternion!.normalize();
        }

        // Optional roll via keyboard
        const rollInput = (this.inputs.rollRight - this.inputs.rollLeft);
        if (rollInput) {
            const fwd = this.camera.getDirection(Vector3.Forward());
            const qRoll = Quaternion.RotationAxis(fwd, rollInput * 0.5 * dt); // ~0.5 rad/s
            this.camera.rotationQuaternion = qRoll.multiply(this.camera.rotationQuaternion!);
            this.camera.rotationQuaternion!.normalize();
        }

        // 3) Translation — keyboard only (no mouse-driven forward)
        const right = this.camera.getDirection(Vector3.Right());
        const up = this.camera.getDirection(Vector3.Up());
        const fwd = this.camera.getDirection(Vector3.Forward());

        // Acceleration per axis
        let acceleration = this.opts.acceleration;
        if (this.inputs.boost) acceleration *= this.opts.boostMultiplier;

        this.velocity.addInPlace(fwd.scale(this.inputs.fwd * acceleration * dt));
        this.velocity.addInPlace(right.scale(this.inputs.strafe * this.opts.strafeAcceleration * dt));
        this.velocity.addInPlace(up.scale(this.inputs.rise * this.opts.strafeAcceleration * dt));

        // Brake / damping
        const damping = this.inputs.brake ? this.opts.brakeDamping : this.opts.damping;
        const dampFactor = Math.exp(-damping * dt * 60);
        this.velocity.scaleInPlace(dampFactor);

        // Kill micro-drift
        if (this.velocity.lengthSquared() < 1e-6) this.velocity.set(0, 0, 0);

        // Clamp total speed
        const speed = this.velocity.length();
        if (speed > this.opts.maxSpeed) this.velocity.scaleInPlace(this.opts.maxSpeed / speed);

        // 4) Move in world (floating-origin): apply velocity to doublepos
        if (this.velocity.lengthSquared() > 0) {
            this.camera.doublepos.addInPlace(this.velocity.scale(dt));
        }

        // (Optional) If you keep a debug target, compute it without setTarget:
        // const lookD = 10; this.camera.doubletgt = this.camera.doublepos.add(fwd.scale(lookD));
    };
}
