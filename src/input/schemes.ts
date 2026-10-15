// input/schemes.ts — desktop, touch, and XR input schemes.
// Each scheme accumulates raw input events (fed by DOM handlers in the demo)
// and drives the shared CameraRig on poll(). DOM-free; unit-testable in node.
import { CameraRig, ZERO_INTENT, type MoveIntent, type RigMode } from './rig.js';
import type { SchemeId } from './detect.js';
import type { XRControllerState } from '../bridge/providers.js';

export type { XRControllerState };

export interface InputScheme {
  readonly id: SchemeId;
  /** Lines shown in the demo's on-screen help for the active scheme. */
  readonly helpLines: string[];
  /** Apply accumulated input to the rig for one frame; clears per-frame deltas. */
  poll(rig: CameraRig, dt: number): void;
  /** Preferred rig mode for this scheme ('fly' default). */
  readonly rigMode: RigMode;
}

const clamp1 = (v: number): number => Math.min(1, Math.max(-1, v));

/** Desktop: WASD + arrows to move, mouse to look (pointer lock preferred,
 *  drag deltas accepted as fallback), Q/E or Space to move down/up. */
export class DesktopScheme implements InputScheme {
  readonly id: SchemeId = 'desktop';
  readonly rigMode: RigMode = 'fly';
  readonly helpLines = [
    'WASD / arrow keys: move',
    'Mouse: look (click the scene to lock the pointer)',
    'Q / E: down / up (Space also rises)',
    'Scroll: zoom (orbit mode)',
  ];
  private keys = new Set<string>();
  private lookDX = 0;
  private lookDY = 0;
  pointerLocked = false;
  lookSensitivity = 0.0026; // radians per pixel

  onKeyDown(code: string): void { this.keys.add(code); }
  onKeyUp(code: string): void { this.keys.delete(code); }
  clearKeys(): void { this.keys.clear(); }
  setPointerLocked(locked: boolean): void {
    this.pointerLocked = locked;
    if (!locked) this.clearKeys();
  }
  /** Pixel deltas from pointer-lock movement or drag fallback. */
  onMouseDelta(dx: number, dy: number): void {
    this.lookDX += dx * this.lookSensitivity;
    this.lookDY += dy * this.lookSensitivity;
  }

  poll(rig: CameraRig, dt: number): void {
    const k = this.keys;
    const intent: MoveIntent = { ...ZERO_INTENT };
    if (k.has('KeyW') || k.has('ArrowUp')) intent.forward += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) intent.forward -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) intent.strafe += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) intent.strafe -= 1;
    if (k.has('KeyE') || k.has('Space')) intent.up += 1;
    if (k.has('KeyQ')) intent.up -= 1;
    intent.forward = clamp1(intent.forward);
    intent.strafe = clamp1(intent.strafe);
    intent.up = clamp1(intent.up);
    intent.lookDX = this.lookDX;
    intent.lookDY = this.lookDY;
    this.lookDX = 0;
    this.lookDY = 0;
    rig.moveIntent(intent, dt);
  }
}

interface TouchPoint { x: number; y: number; ox: number; oy: number; zone: 'move' | 'look' }

/** Touch: left-half virtual joystick to move, right-half drag to look.
 *  The joystick renders from joystick() state in the demo overlay. */
export class TouchScheme implements InputScheme {
  readonly id: SchemeId = 'touch';
  readonly rigMode: RigMode = 'fly';
  readonly helpLines = [
    'Left thumb: virtual joystick to move',
    'Right thumb: drag to look',
  ];
  private touches = new Map<number, TouchPoint>();
  private lookDX = 0;
  private lookDY = 0;
  joystickRadius = 60; // px
  lookSensitivity = 0.0042; // radians per pixel

  onTouchStart(id: number, x: number, y: number, viewportWidth: number): void {
    this.touches.set(id, { x, y, ox: x, oy: y, zone: x < viewportWidth / 2 ? 'move' : 'look' });
  }
  onTouchMove(id: number, x: number, y: number): void {
    const t = this.touches.get(id);
    if (!t) return;
    if (t.zone === 'look') {
      this.lookDX += (x - t.x) * this.lookSensitivity;
      this.lookDY += (y - t.y) * this.lookSensitivity;
    }
    t.x = x; t.y = y;
  }
  onTouchEnd(id: number): void { this.touches.delete(id); }
  clearTouches(): void { this.touches.clear(); this.lookDX = 0; this.lookDY = 0; }

  /** Joystick state for the demo overlay; null when no move touch is down. */
  joystick(): { ox: number; oy: number; dx: number; dy: number } | null {
    for (const t of this.touches.values()) {
      if (t.zone !== 'move') continue;
      const r = this.joystickRadius;
      const dx = clamp1((t.x - t.ox) / r) * r;
      const dy = clamp1((t.y - t.oy) / r) * r;
      return { ox: t.ox, oy: t.oy, dx, dy };
    }
    return null;
  }

  poll(rig: CameraRig, dt: number): void {
    const intent: MoveIntent = { ...ZERO_INTENT };
    const j = this.joystick();
    if (j) {
      intent.strafe = clamp1(j.dx / this.joystickRadius);
      intent.forward = clamp1(-j.dy / this.joystickRadius);
    }
    intent.lookDX = this.lookDX;
    intent.lookDY = this.lookDY;
    this.lookDX = 0;
    this.lookDY = 0;
    rig.moveIntent(intent, dt);
  }
}

/** XR: thumbsticks to move and turn, trigger to rise. Look comes from the
 *  headset itself in immersive mode (that is how VR works); the scheme only
 *  drives locomotion on the rig, which the XR session applies as a
 *  reference-space offset. */
export class XRInputScheme implements InputScheme {
  readonly id: SchemeId = 'xr';
  readonly rigMode: RigMode = 'fly';
  readonly helpLines = [
    'Headset: look around naturally',
    'Left thumbstick: move',
    'Right thumbstick: turn / rise and sink',
    'Trigger: rise',
  ];
  private controllers: XRControllerState[] = [];
  deadzone = 0.15;
  turnSpeed = 1.8; // radians per second at full deflection

  setControllers(controllers: XRControllerState[]): void {
    this.controllers = controllers;
  }

  private dz(v: number): number {
    return Math.abs(v) < this.deadzone ? 0 : v;
  }

  poll(rig: CameraRig, dt: number): void {
    const intent: MoveIntent = { ...ZERO_INTENT };
    for (const c of this.controllers) {
      const ax = c.axes;
      const lx = this.dz(ax[0] ?? 0), ly = this.dz(ax[1] ?? 0);
      const rx = this.dz(ax[2] ?? 0), ry = this.dz(ax[3] ?? 0);
      if (c.handedness === 'right') {
        // Right stick: turn with X, vertical with Y.
        rig.yaw -= rx * this.turnSpeed * dt;
        intent.up += -ry;
      } else {
        // Left stick (or unknown): planar movement.
        intent.strafe += lx;
        intent.forward += -ly;
      }
      if (c.buttons[0]) intent.up += 1; // trigger rises
    }
    intent.strafe = clamp1(intent.strafe);
    intent.forward = clamp1(intent.forward);
    intent.up = clamp1(intent.up);
    rig.moveIntent(intent, dt);
  }
}
