// input/rig.ts — one camera rig that every input scheme drives.
// No per-device camera hacks: desktop, touch, and XR schemes all feed the
// same rig (position + yaw/pitch), and the rig writes the scene camera node.
// DOM-free; runs in node tests.
import { v3, type Vec3 } from '../math/vec.js';
import { fromAxisAngle, multiply as quatMultiply } from '../math/quat.js';
import type { SceneNode } from '../scene/node.js';

export type RigMode = 'fly' | 'orbit';

/** Per-frame movement intent, each field in [-1, 1]. Look deltas are in
 *  units of full deflection; the rig scales them by lookSpeed. */
export interface MoveIntent {
  forward: number;
  strafe: number;
  up: number;
  lookDX: number;
  lookDY: number;
}

export const ZERO_INTENT: MoveIntent = { forward: 0, strafe: 0, up: 0, lookDX: 0, lookDY: 0 };

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const PITCH_LIMIT = 1.45; // ~83 degrees

export class CameraRig {
  position: Vec3 = v3(0, 7, 20);
  yaw = 0;
  pitch = -0.18;
  moveSpeed = 8; // world units per second at full deflection
  lookSpeed = 2.6; // radians per second at full deflection
  mode: RigMode = 'fly';
  // Orbit-mode state (the classic drag-to-orbit view, kept as an alternative).
  orbitTarget: Vec3 = v3(0, 4, -4);
  orbitDist = 24;

  /** Rotate the view. Positive dx looks right, positive dy looks up. */
  addLook(dx: number, dy: number): void {
    this.yaw -= dx;
    this.pitch = clamp(this.pitch - dy, -PITCH_LIMIT, PITCH_LIMIT);
  }

  /** Move in the yaw plane (fly mode only) and apply look. */
  moveIntent(i: MoveIntent, dt: number): void {
    this.addLook(i.lookDX * this.lookSpeed * dt, i.lookDY * this.lookSpeed * dt);
    const s = Math.sin(this.yaw), c = Math.cos(this.yaw);
    // Forward is local -Z rotated by yaw; right is local +X rotated by yaw.
    const fx = -s, fz = -c, rx = c, rz = -s;
    const d = this.moveSpeed * dt;
    const mx = (fx * i.forward + rx * i.strafe) * d;
    const mz = (fz * i.forward + rz * i.strafe) * d;
    const my = i.up * d;
    if (this.mode === 'fly') {
      this.position[0] += mx;
      this.position[2] += mz;
      this.position[1] += my;
    } else {
      // Orbit mode: movement pans the target the camera circles.
      this.orbitTarget[0] += mx;
      this.orbitTarget[2] += mz;
      this.orbitTarget[1] += my;
    }
  }

  /** Zoom the orbit distance (orbit mode only). Positive delta zooms out. */
  addZoom(delta: number): void {
    if (this.mode === 'orbit') {
      this.orbitDist = clamp(this.orbitDist + delta, 6, 60);
    }
  }

  /** Write the rig state onto a scene camera node. The camera looks along
   *  its local -Z axis, so orientation is yaw * pitch in both modes; only
   *  the position source differs. */
  applyTo(node: SceneNode): void {
    if (this.mode === 'orbit') {
      const cp = Math.cos(this.pitch);
      node.setPosition(
        this.orbitTarget[0] + this.orbitDist * Math.sin(this.yaw) * cp,
        this.orbitTarget[1] + this.orbitDist * Math.sin(-this.pitch),
        this.orbitTarget[2] + this.orbitDist * Math.cos(this.yaw) * cp,
      );
    } else {
      node.setPosition(this.position[0], this.position[1], this.position[2]);
    }
    node.rotation = quatMultiply(
      fromAxisAngle([0, 1, 0], this.yaw),
      fromAxisAngle([1, 0, 0], this.pitch),
    );
    node.markDirty();
  }
}
