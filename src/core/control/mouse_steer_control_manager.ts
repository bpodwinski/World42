import {
    Scene,
    Vector3,
    Quaternion,
    KeyboardEventTypes,
    AbstractMesh,
    type KeyboardInfo,
    type Observer,
} from "@babylonjs/core";
import { OriginCamera } from "../camera/camera_manager";
import { GuiManager } from "../gui/gui_manager";
import { DisposableRegistry } from "../lifecycle/disposable_registry";

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

    /** Mouse-look sensitivity in radians of rotation per pixel of mouse movement */
    mouseSensitivity?: number;

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

    /** Maximum yaw angular acceleration (rad/s^2) */
    yawAcceleration?: number;

    /** Maximum pitch angular acceleration (rad/s^2) */
    pitchAcceleration?: number;

    /**
     * Angular damping factor (0..1), applied every frame on angular velocities.
     * 0 = no damping, 0.2..0.6 = typical, 1 = extremely strong.
     */
    angularDamping?: number;

    /** How fast the mouse deflection follows when held (0..1, higher = snappier) */
    steerFollow?: number;

    /** Exponential decay of deflection when LMB released (0..1 per frame @60fps) */
    releaseDamping?: number;
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
    private beforeRenderObserver?: Observer<Scene>;
    private readonly disposables = new DisposableRegistry();

    private mouseActiveInWindow = true;
    private lmbDown = false;

    public gui?: GuiManager;

    // --- Mouse movement accumulated since the last frame (pixels), for mouse-look ---
    private _mouseDX = 0;
    private _mouseDY = 0;

    private collider?: AbstractMesh;
    private _delta = new Vector3();

    constructor(camera: OriginCamera, scene: Scene, canvas: HTMLCanvasElement, collider?: AbstractMesh, opts: SpaceFlightOpts = {}) {
        this.camera = camera;
        this.scene = scene;
        this.canvas = canvas;
        this.collider = collider;
        this.opts = {
            deadzonePx: opts.deadzonePx ?? 50,
            maxRadiusPx: opts.maxRadiusPx ?? 500,
            responseCurve: opts.responseCurve ?? 1.0,
            maxYawRate: opts.maxYawRate ?? 0.75,
            maxPitchRate: opts.maxPitchRate ?? 0.75,
            invertY: opts.invertY ?? false,
            mouseSensitivity: opts.mouseSensitivity ?? 0.0022,
            acceleration: opts.acceleration ?? 2,
            strafeAcceleration: opts.strafeAcceleration ?? 2,
            maxSpeed: opts.maxSpeed ?? 5000,
            damping: opts.damping ?? 0.02,
            boostMultiplier: opts.boostMultiplier ?? 50,
            brakeDamping: opts.brakeDamping ?? 0.3,
            yawAcceleration: opts.yawAcceleration ?? 10,
            pitchAcceleration: opts.pitchAcceleration ?? 10,
            angularDamping: opts.angularDamping ?? 0.3,
            steerFollow: opts.steerFollow ?? 0.5,
            releaseDamping: opts.releaseDamping ?? 0.08,
        };

        // Ensure we rotate with quaternions. Preserve any orientation already set
        // via Euler `rotation` (e.g. a spawn setTarget) instead of clobbering it
        // with identity — otherwise the camera always snaps to facing +Z.
        if (!this.camera.rotationQuaternion) {
            this.camera.rotationQuaternion = Quaternion.FromEulerVector(this.camera.rotation);
        }

        // Disable native pointer inputs for this camera
        this.camera.inputs.clear();
        // (Optional) reliable keyboard focus
        this.canvas.tabIndex = 1;
        this.canvas.addEventListener("click", () => this.canvas.focus());

        this.bindInputs();
        this.beforeRenderObserver = this.scene.onBeforeRenderObservable.add(this.update);
    }

    private _deltaFrame = new Vector3();
    private _deltaStep = new Vector3();
    private _moveWithSubSteps(deltaRender: Vector3): void {
        const collider = this.collider;
        if (!collider) {
            this.camera.position.addInPlace(deltaRender);
            return;
        }

        // Copier le delta (NE PAS réutiliser le même vecteur en input/output)
        this._deltaFrame.copyFrom(deltaRender);

        const ell = (collider as AbstractMesh & { ellipsoid?: Vector3 }).ellipsoid;
        const radiusApprox = ell ? Math.max(ell.x, ell.y, ell.z) : 3;
        const maxStep = Math.max(0.25, radiusApprox * 0.25);

        const dist = this._deltaFrame.length();
        if (dist <= 1e-9) return;

        const steps = Math.min(32, Math.max(1, Math.ceil(dist / maxStep)));
        const inv = 1 / steps;

        // step = deltaFrame / steps (constant)
        this._deltaFrame.scaleToRef(inv, this._deltaStep);

        for (let i = 0; i < steps; i++) {
            collider.moveWithCollisions(this._deltaStep);
        }

        this.camera.position.copyFrom(collider.position);
    }

    public dispose(): void {
        this.unbindInputs();
        if (this.beforeRenderObserver) {
            this.scene.onBeforeRenderObservable.remove(this.beforeRenderObserver);
            this.beforeRenderObserver = undefined;
        }
    }

    private bindInputs(): void {
        const updateRect = () => { this.rect = this.canvas.getBoundingClientRect(); };
        const centerMouse = () => {
            if (!this.rect) updateRect();
            const r = this.rect!;
            this.mouseX = r.width * 0.5;
            this.mouseY = r.height * 0.5;
        };

        // --- Pointer events ---
        const onPointerDown = (e: PointerEvent) => {
            if (this.rect && this.gui) this.gui.updateMouseCrosshair(e.clientX, e.clientY, this.rect);
            if (e.pointerType === "mouse" && e.button !== 0) return;

            this.canvas.setPointerCapture(e.pointerId);
            e.preventDefault();

            this.lmbDown = true;
            // Reset the look accumulator so the first frame doesn't jump.
            this._mouseDX = 0;
            this._mouseDY = 0;

            if (this.gui) this.gui.setMouseCrosshairActive(true);

            if (!this.rect) updateRect();
            const r = this.rect!;
            this.mouseX = e.clientX - r.left;
            this.mouseY = e.clientY - r.top;
        };

        const onPointerUp = (e: PointerEvent) => {
            if (e.pointerType === "mouse" && e.button !== 0) return;
            try { this.canvas.releasePointerCapture(e.pointerId); } catch { }

            this.lmbDown = false;

            if (this.gui) this.gui.setMouseCrosshairActive(false);
        };

        const onPointerMove = (e: PointerEvent) => {
            if (this.rect && this.gui) this.gui.updateMouseCrosshair(e.clientX, e.clientY, this.rect);
            if (!this.rect) updateRect();

            const r = this.rect!;
            this.mouseX = e.clientX - r.left;
            this.mouseY = e.clientY - r.top;

            // Accumulate raw movement for mouse-look (only while steering).
            if (this.lmbDown) {
                this._mouseDX += e.movementX;
                this._mouseDY += e.movementY;
            }
        };

        const onContextMenu = (e: MouseEvent) => e.preventDefault();

        const onResize = () => { updateRect(); centerMouse(); };
        const onWindowFocus = () => { this.mouseActiveInWindow = true; };

        const onWindowBlur = () => {
            this.mouseActiveInWindow = false;
            this.lmbDown = false;

            if (this.gui) this.gui.setMouseCrosshairActive(false);

            centerMouse();
        };

        const onWindowMouseOut = (e: MouseEvent) => {
            if (!e.relatedTarget) {
                this.mouseActiveInWindow = false;
                this.lmbDown = false;
                centerMouse();
            }
        };

        const onVisibilityChange = () => {
            this.mouseActiveInWindow = !document.hidden && document.hasFocus();
            if (!this.mouseActiveInWindow) {
                this.lmbDown = false;

                if (this.gui) this.gui.setMouseCrosshairActive(false);

                centerMouse();
            }
        };

        this.disposables.addDomListener(this.canvas, "pointerdown", onPointerDown);
        this.disposables.addDomListener(this.canvas, "pointerup", onPointerUp);
        this.disposables.addDomListener(this.canvas, "pointermove", onPointerMove, { passive: true });
        this.disposables.addDomListener(this.canvas, "contextmenu", onContextMenu);

        this.disposables.addDomListener(window, "resize", onResize);
        this.disposables.addDomListener(window, "focus", onWindowFocus);
        this.disposables.addDomListener(window, "blur", onWindowBlur);
        this.disposables.addDomListener(window, "mouseout", onWindowMouseOut);
        this.disposables.addDomListener(document, "visibilitychange", onVisibilityChange);

        this.rect = this.canvas.getBoundingClientRect();
        centerMouse();

        // --- Keyboard ---
        const keyboardObserver: Observer<KeyboardInfo> | null =
            this.scene.onKeyboardObservable.add((kb) => {
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
        this.disposables.addBabylonObserver(this.scene.onKeyboardObservable, keyboardObserver);
    }

    private unbindInputs(): void {
        this.disposables.dispose();
    }

    /**
     * Per-frame update: applies mouse-look rotation from accumulated mouse movement,
     * roll/translation from keyboard, and floating-origin movement.
     */
    private update = (): void => {
        const dt = this.scene.getEngine().getDeltaTime() * 0.001;
        if (dt <= 0 || !this.rect) return;

        // Steering only when window active + LMB held
        const steerEnabled = this.mouseActiveInWindow && this.lmbDown;

        // Direct mouse-look: the mouse MOVEMENT (delta accumulated since last frame)
        // rotates the view 1:1 about the camera's own right/up axes (in place — no
        // orbit, no rate/inertia). Crisp and predictable.
        if (steerEnabled && (this._mouseDX !== 0 || this._mouseDY !== 0)) {
            const sens = this.opts.mouseSensitivity; // radians per pixel
            const yawAngle = this._mouseDX * sens;
            // Mouse up (negative movementY) must look up → scene moves DOWN. The
            // base sign is negated for that standard (non-inverted) feel.
            let pitchAngle = -this._mouseDY * sens;
            if (this.opts.invertY) pitchAngle = -pitchAngle;

            const right = this.camera.getDirection(Vector3.Right());
            const up = this.camera.getDirection(Vector3.Up());
            const qYaw = Quaternion.RotationAxis(up, yawAngle);
            const qPitch = Quaternion.RotationAxis(right, pitchAngle);

            this.camera.rotationQuaternion = qPitch.multiply(qYaw).multiply(this.camera.rotationQuaternion!);
            this.camera.rotationQuaternion!.normalize();
        }
        // Consume the accumulated delta every frame (also discards motion while not steering).
        this._mouseDX = 0;
        this._mouseDY = 0;

        // Optional roll via keyboard
        const rollInput = (this.inputs.rollRight - this.inputs.rollLeft);
        if (rollInput) {
            const fwd = this.camera.getDirection(Vector3.Forward());
            const qRoll = Quaternion.RotationAxis(fwd, rollInput * 0.5 * dt); // ~0.5 rad/s
            this.camera.rotationQuaternion = qRoll.multiply(this.camera.rotationQuaternion!);
            this.camera.rotationQuaternion!.normalize();
        }

        // 5) Translation — keyboard only
        const right = this.camera.getDirection(Vector3.Right());
        const up = this.camera.getDirection(Vector3.Up());
        const fwd = this.camera.getDirection(Vector3.Forward());

        let acceleration = this.opts.acceleration;
        if (this.inputs.boost) acceleration *= this.opts.boostMultiplier;

        this.velocity.addInPlace(fwd.scale(this.inputs.fwd * acceleration * dt));
        this.velocity.addInPlace(right.scale(this.inputs.strafe * this.opts.strafeAcceleration * dt));
        this.velocity.addInPlace(up.scale(this.inputs.rise * this.opts.strafeAcceleration * dt));

        // Brake / damping (linear)
        const damping = this.inputs.brake ? this.opts.brakeDamping : this.opts.damping;
        const dampFactor = Math.exp(-damping * dt * 60);
        this.velocity.scaleInPlace(dampFactor);

        if (this.velocity.lengthSquared() < 1e-6) this.velocity.set(0, 0, 0);

        // Clamp total speed
        const speed = this.velocity.length();
        if (speed > this.opts.maxSpeed) this.velocity.scaleInPlace(this.opts.maxSpeed / speed);

        // 6) Move (Render-space)
        if (this.velocity.lengthSquared() > 0) {
            this.velocity.scaleToRef(dt, this._delta); // deltaRender = v * dt
            this._moveWithSubSteps(this._delta);
        }
    };
}
