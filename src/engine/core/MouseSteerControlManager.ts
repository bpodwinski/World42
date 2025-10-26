import { Scene, Vector3, Quaternion, KeyboardEventTypes } from "@babylonjs/core";
import { OriginCamera } from "./CameraManager";
import { GuiManager } from "./gui/GuiManager";

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
 * - Mouse controls **yaw/pitch** based on cursor offset from screen center
 * - Roll and translation are **keyboard** driven (Z/S, Q/D, R/F, E/A, Shift/Ctrl)
 * - Movement is applied to `OriginCamera.doublepos` (floating-origin friendly)
 *
 * This controller does **not** bind pointer-lock; it reads absolute mouse position in the canvas
 */
export class MouseSteerControlManager {
    private camera: OriginCamera;
    private scene: Scene;
    private canvas: HTMLCanvasElement;

    /** World-space (double) linear velocity integrated each frame */
    private velocity = new Vector3();

    /** Keyboard inputs state (ZQSD/RF + roll + boost/brake) */
    private inputs = { fwd: 0, strafe: 0, rise: 0, rollLeft: 0, rollRight: 0, boost: 0, brake: 0 };

    private mouseX = 0;
    private mouseY = 0;
    private rect?: DOMRect;

    private opts: Required<SpaceFlightOpts>;
    private beforeRenderObserver?: any;

    private mouseActiveInWindow = true;
    private lmbDown = false;

    public gui?: GuiManager;

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
            acceleration: opts.acceleration ?? 10,
            strafeAcceleration: opts.strafeAcceleration ?? 10,
            maxSpeed: opts.maxSpeed ?? 1500,
            damping: opts.damping ?? 0.02,
            boostMultiplier: opts.boostMultiplier ?? 5,
            brakeDamping: opts.brakeDamping ?? 0.3,
        };

        // Ensure we rotate with quaternions (never use setTarget for 6DOF)
        if (!this.camera.rotationQuaternion) this.camera.rotationQuaternion = Quaternion.Identity();

        // Désactive les inputs souris natifs de Babylon pour cette caméra
        this.camera.inputs.clear();
        // (Optionnel) focus clavier fiable
        (this.canvas as any).tabIndex = 1;
        this.canvas.addEventListener("click", () => this.canvas.focus());

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
     * Registers input listeners for pointer (absolute position) and keyboard
     */
    private bindInputs(): void {
        const updateRect = () => { this.rect = this.canvas.getBoundingClientRect(); };
        const centerMouse = () => {
            if (!this.rect) updateRect();
            const r = this.rect!;
            this.mouseX = r.width * 0.5;
            this.mouseY = r.height * 0.5;
        };

        // --- POINTER EVENTS avec capture (béton) ---
        const onPointerDown = (e: PointerEvent) => {
            if (this.rect && this.gui) {
                this.gui.updateMouseCrosshair(e.clientX, e.clientY, this.rect);
            }

            // On n'active que pour LMB (ou touch)
            if (e.pointerType === "mouse" && e.button !== 0) return;
            this.canvas.setPointerCapture(e.pointerId);
            e.preventDefault(); // évite la sélection/drag natif
            this.lmbDown = true;
            if (!this.rect) updateRect();
            // maj position immédiate
            const r = this.rect!;
            this.mouseX = e.clientX - r.left;
            this.mouseY = e.clientY - r.top;
        };

        const onPointerUp = (e: PointerEvent) => {
            if (e.pointerType === "mouse" && e.button !== 0) return;
            try { this.canvas.releasePointerCapture(e.pointerId); } catch { }
            this.lmbDown = false;
        };

        const onPointerMove = (e: PointerEvent) => {
            if (this.rect && this.gui) {
                this.gui.updateMouseCrosshair(e.clientX, e.clientY, this.rect);
            }

            if (!this.rect) updateRect();
            const r = this.rect!;
            this.mouseX = e.clientX - r.left;
            this.mouseY = e.clientY - r.top;
        };

        // Empêche menu contextuel qui casse le drag
        const onContextMenu = (e: MouseEvent) => e.preventDefault();

        const onResize = () => {
            updateRect();
            centerMouse();
        };

        const onWindowFocus = () => { this.mouseActiveInWindow = true; };
        const onWindowBlur = () => { this.mouseActiveInWindow = false; this.lmbDown = false; centerMouse(); };

        const onWindowMouseOut = (e: MouseEvent) => {
            if (!e.relatedTarget && !(e as any).toElement) {
                this.mouseActiveInWindow = false;
                this.lmbDown = false;
                centerMouse();
            }
        };

        const onVisibilityChange = () => {
            this.mouseActiveInWindow = !document.hidden && document.hasFocus();
            if (!this.mouseActiveInWindow) { this.lmbDown = false; centerMouse(); }
        };

        // Listeners
        this.canvas.addEventListener("pointerdown", onPointerDown);
        this.canvas.addEventListener("pointerup", onPointerUp);
        this.canvas.addEventListener("pointermove", onPointerMove, { passive: true });
        this.canvas.addEventListener("contextmenu", onContextMenu);

        window.addEventListener("resize", onResize);
        window.addEventListener("focus", onWindowFocus);
        window.addEventListener("blur", onWindowBlur);
        window.addEventListener("mouseout", onWindowMouseOut);
        document.addEventListener("visibilitychange", onVisibilityChange);

        this.rect = this.canvas.getBoundingClientRect();
        centerMouse();

        // --- Clavier ---
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
            onPointerDown, onPointerUp, onPointerMove,
            onContextMenu,
            onResize, onWindowFocus, onWindowBlur, onWindowMouseOut, onVisibilityChange
        };
    }

    /**
     * Unregisters input listeners
     */
    private unbindInputs(): void {
        const L = (this as any)._listeners;
        if (!L) return;

        this.canvas.removeEventListener("pointerdown", L.onPointerDown);
        this.canvas.removeEventListener("pointerup", L.onPointerUp);
        this.canvas.removeEventListener("pointermove", L.onPointerMove);
        this.canvas.removeEventListener("contextmenu", L.onContextMenu);

        window.removeEventListener("resize", L.onResize);
        window.removeEventListener("focus", L.onWindowFocus);
        window.removeEventListener("blur", L.onWindowBlur);
        window.removeEventListener("mouseout", L.onWindowMouseOut);
        document.removeEventListener("visibilitychange", L.onVisibilityChange);
    }

    /**
     * Per-frame update: computes yaw/pitch from mouse offset, roll/translation from keyboard integrates velocity, and applies floating-origin movement via `doublepos`
     */
    private update = (): void => {
        const dt = this.scene.getEngine().getDeltaTime() * 0.001;
        if (dt <= 0 || !this.rect) return;

        // Steering actif uniquement si fenêtre active + LMB maintenu
        const steerEnabled = this.mouseActiveInWindow && this.lmbDown;

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

        // 4) Move in world (floating-origin): apply velocity to doubleposzzzzzz
        if (this.velocity.lengthSquared() > 0) {
            this.camera.doublepos.addInPlace(this.velocity.scale(dt));
        }

        // (Optional) debug rapide:
        // console.log({ steerEnabled, yawRate, pitchRate, mouseX: this.mouseX, mouseY: this.mouseY });
    };
}
