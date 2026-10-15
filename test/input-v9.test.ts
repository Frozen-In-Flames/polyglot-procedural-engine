// Unit tests for the V9 unified input system (runs in node, no browser).
// The input core is DOM-free by design: detection reads an injected env,
// schemes take raw events through methods, and the rig writes scene nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CameraRig } from '../src/input/rig.js';
import { collectCaps, pickScheme } from '../src/input/detect.js';
import { DesktopScheme, TouchScheme, XRInputScheme } from '../src/input/schemes.js';
import { SceneNode } from '../src/scene/node.js';

const approx = (a: number, b: number, eps = 1e-6): void => {
  assert.ok(Math.abs(a - b) < eps, `expected ${a} ~= ${b}`);
};

// ---- CameraRig ----

test('rig: starts at the classic First Light framing', () => {
  const rig = new CameraRig();
  assert.deepEqual([...rig.position], [0, 7, 20]);
  assert.equal(rig.mode, 'fly');
});

test('rig: addLook rotates yaw and clamps pitch', () => {
  const rig = new CameraRig();
  rig.addLook(Math.PI / 2, 0);
  approx(rig.yaw, -Math.PI / 2);
  rig.addLook(0, -100); // look far up
  approx(rig.pitch, 1.45);
  rig.addLook(0, 100); // look far down
  approx(rig.pitch, -1.45);
});

test('rig: W moves the camera forward along its yaw', () => {
  const rig = new CameraRig();
  rig.yaw = 0; // facing -Z
  rig.moveIntent({ forward: 1, strafe: 0, up: 0, lookDX: 0, lookDY: 0 }, 1);
  approx(rig.position[2], 20 - rig.moveSpeed);
  approx(rig.position[0], 0);
});

test('rig: strafe is perpendicular to facing', () => {
  const rig = new CameraRig();
  rig.yaw = Math.PI / 2; // facing -X
  rig.moveIntent({ forward: 1, strafe: 0, up: 0, lookDX: 0, lookDY: 0 }, 1);
  approx(rig.position[0], 0 - rig.moveSpeed);
});

test('rig: up intent changes height only', () => {
  const rig = new CameraRig();
  rig.moveIntent({ forward: 0, strafe: 0, up: 1, lookDX: 0, lookDY: 0 }, 0.5);
  approx(rig.position[1], 7 + rig.moveSpeed * 0.5);
});

test('rig: applyTo writes position and orientation to the node', () => {
  const rig = new CameraRig();
  rig.pitch = 0; // level the camera so forward is exactly -Z
  const node = new SceneNode('cam');
  rig.applyTo(node);
  node.updateWorldMatrix(null);
  approx(node.worldMatrix[12], 0);
  approx(node.worldMatrix[13], 7);
  approx(node.worldMatrix[14], 20);
  // Camera looks along local -Z: with yaw 0 the forward is -Z.
  const fx = -node.worldMatrix[8], fz = -node.worldMatrix[10];
  approx(fx, 0);
  approx(fz, -1);
});

test('rig: orbit mode positions the camera around the target', () => {
  const rig = new CameraRig();
  rig.mode = 'orbit';
  rig.yaw = 0;
  rig.pitch = 0;
  const node = new SceneNode('cam');
  rig.applyTo(node);
  node.updateWorldMatrix(null);
  // yaw 0, pitch 0: camera sits at target + (0, 0, dist).
  approx(node.worldMatrix[12], rig.orbitTarget[0]);
  approx(node.worldMatrix[13], rig.orbitTarget[1]);
  approx(node.worldMatrix[14], rig.orbitTarget[2] + rig.orbitDist);
  // ...and still faces the target.
  const dx = rig.orbitTarget[0] - node.worldMatrix[12];
  const dz = rig.orbitTarget[2] - node.worldMatrix[14];
  const fx = -node.worldMatrix[8], fz = -node.worldMatrix[10];
  approx(fx / Math.hypot(fx, fz), dx / Math.hypot(dx, dz));
  approx(fz / Math.hypot(fx, fz), dz / Math.hypot(dx, dz));
});

test('rig: orbit zoom clamps, fly ignores zoom', () => {
  const rig = new CameraRig();
  rig.mode = 'orbit';
  rig.addZoom(1000);
  assert.equal(rig.orbitDist, 60);
  rig.addZoom(-1000);
  assert.equal(rig.orbitDist, 6);
  rig.mode = 'fly';
  rig.addZoom(5);
  assert.equal(rig.orbitDist, 6); // unchanged
});

// ---- Device detection ----

test('detect: desktop by default', async () => {
  const caps = await collectCaps({ navigator: { maxTouchPoints: 0 } });
  assert.equal(pickScheme(caps, 'auto'), 'desktop');
});

test('detect: touch points pick the touch scheme', async () => {
  const caps = await collectCaps({ navigator: { maxTouchPoints: 5 } });
  assert.equal(caps.touchPoints, 5);
  assert.equal(pickScheme(caps, 'auto'), 'touch');
});

test('detect: coarse pointer picks the touch scheme', async () => {
  const caps = await collectCaps({
    navigator: { maxTouchPoints: 0 },
    matchMedia: () => ({ matches: true }),
  });
  assert.equal(pickScheme(caps, 'auto'), 'touch');
});

test('detect: immersive-vr support picks the xr scheme', async () => {
  const caps = await collectCaps({
    navigator: {
      maxTouchPoints: 0,
      xr: { isSessionSupported: async (m: string) => m === 'immersive-vr' },
    },
  });
  assert.equal(caps.xrImmersiveVr, true);
  assert.equal(pickScheme(caps, 'auto'), 'xr');
});

test('detect: explicit override wins over everything', async () => {
  const caps = await collectCaps({
    navigator: {
      maxTouchPoints: 5,
      xr: { isSessionSupported: async () => true },
    },
  });
  assert.equal(pickScheme(caps, 'desktop'), 'desktop');
  assert.equal(pickScheme(caps, 'touch'), 'touch');
});

test('detect: xr probe failure degrades to desktop, not a throw', async () => {
  const caps = await collectCaps({
    navigator: {
      xr: { isSessionSupported: async () => { throw new Error('denied'); } },
    },
  });
  assert.equal(caps.xrImmersiveVr, false);
  assert.equal(pickScheme(caps, 'auto'), 'desktop');
});

// ---- Desktop scheme ----

test('desktop: WASD moves the rig forward and strafes', () => {
  const rig = new CameraRig();
  const s = new DesktopScheme();
  s.onKeyDown('KeyW');
  s.onKeyDown('KeyD');
  s.poll(rig, 1);
  assert.ok(rig.position[2] < 20, 'moved forward (-Z)');
  assert.ok(rig.position[0] > 0, 'strafed right (+X)');
  s.onKeyUp('KeyW');
  s.onKeyUp('KeyD');
});

test('desktop: arrow keys are a fallback for WASD', () => {
  const rig = new CameraRig();
  const s = new DesktopScheme();
  s.onKeyDown('ArrowUp');
  s.poll(rig, 1);
  assert.ok(rig.position[2] < 20);
});

test('desktop: Space rises, Q sinks', () => {
  const rig = new CameraRig();
  const s = new DesktopScheme();
  s.onKeyDown('Space');
  s.poll(rig, 1);
  assert.ok(rig.position[1] > 7);
  s.onKeyUp('Space');
  s.onKeyDown('KeyQ');
  s.poll(rig, 1);
  approx(rig.position[1], 7);
});

test('desktop: mouse deltas rotate the view and clear each frame', () => {
  const rig = new CameraRig();
  const s = new DesktopScheme();
  s.onMouseDelta(100, 0);
  s.poll(rig, 1);
  assert.ok(rig.yaw < 0, 'yaw turned right');
  const yawAfter = rig.yaw;
  s.poll(rig, 1); // no new deltas: no further rotation
  approx(rig.yaw, yawAfter);
});

test('desktop: unlocking the pointer clears held keys', () => {
  const s = new DesktopScheme();
  s.onKeyDown('KeyW');
  s.setPointerLocked(false);
  const rig = new CameraRig();
  s.poll(rig, 1);
  approx(rig.position[2], 20);
});

// ---- Touch scheme ----

test('touch: left-half drag drives the joystick forward', () => {
  const rig = new CameraRig();
  const s = new TouchScheme();
  s.onTouchStart(1, 100, 400, 800); // left half
  s.onTouchMove(1, 100, 340); // push up
  const j = s.joystick();
  assert.ok(j !== null);
  assert.ok(j.dy < 0, 'joystick deflected up');
  s.poll(rig, 1);
  assert.ok(rig.position[2] < 20, 'moved forward');
  s.onTouchEnd(1);
  assert.equal(s.joystick(), null);
});

test('touch: right-half drag looks around', () => {
  const rig = new CameraRig();
  const s = new TouchScheme();
  s.onTouchStart(2, 700, 400, 800); // right half
  s.onTouchMove(2, 760, 400);
  s.poll(rig, 1);
  assert.ok(rig.yaw < 0, 'looked right');
  s.onTouchEnd(2);
});

test('touch: joystick deflection clamps to the radius', () => {
  const s = new TouchScheme();
  s.onTouchStart(1, 100, 400, 800);
  s.onTouchMove(1, 100 + 10 * s.joystickRadius, 400);
  const j = s.joystick();
  assert.ok(j !== null);
  approx(Math.abs(j.dx), s.joystickRadius);
});

// ---- XR scheme ----

test('xr: left thumbstick moves, deadzone swallows drift', () => {
  const rig = new CameraRig();
  const s = new XRInputScheme();
  s.setControllers([
    { handedness: 'left', axes: [0, -1, 0, 0], buttons: [] },
    { handedness: 'right', axes: [0.05, 0.05, 0.05, 0.05], buttons: [] }, // inside deadzone
  ]);
  const yawBefore = rig.yaw;
  s.poll(rig, 1);
  assert.ok(rig.position[2] < 20, 'left stick pushed forward');
  approx(rig.yaw, yawBefore, 1e-9);
});

test('xr: right thumbstick X turns the rig', () => {
  const rig = new CameraRig();
  const s = new XRInputScheme();
  s.setControllers([{ handedness: 'right', axes: [0, 0, 1, 0], buttons: [] }]);
  s.poll(rig, 1);
  assert.ok(rig.yaw < 0, 'turned right');
});

test('xr: trigger rises', () => {
  const rig = new CameraRig();
  const s = new XRInputScheme();
  s.setControllers([{ handedness: 'left', axes: [0, 0, 0, 0], buttons: [true] }]);
  s.poll(rig, 1);
  assert.ok(rig.position[1] > 7);
});

test('xr: no controllers means no movement', () => {
  const rig = new CameraRig();
  const s = new XRInputScheme();
  s.setControllers([]);
  s.poll(rig, 1);
  assert.deepEqual([...rig.position], [0, 7, 20]);
});
