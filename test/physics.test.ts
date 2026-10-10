// Tests the v2 physics core: determinism, gravity, terrain collision.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ParticleSystem, type Collider } from '../src/physics/particles.js';
import { particleGeometry, writeParticles } from '../src/physics/particleMesh.js';

const flat: Collider = { heightAt: () => 0 };

test('particles: deterministic for a seed', () => {
  const mk = () => {
    const s = new ParticleSystem(99, { max: 64 });
    s.burst(0, 5, 0, 1, 2, 3, 4, 0.2, 32);
    return s;
  };
  const a = mk(), b = mk();
  for (let i = 0; i < 60; i++) { a.step(1 / 60, flat); b.step(1 / 60, flat); }
  assert.deepEqual([...a.pos.slice(0, a.count * 3)], [...b.pos.slice(0, b.count * 3)]);
});

test('particles: gravity pulls down', () => {
  const s = new ParticleSystem(1, { max: 8, gravity: -9.8, drag: 0 });
  s.spawn(0, 10, 0, 0, 0, 0, 10);
  const y0 = s.pos[1];
  s.step(0.5);
  assert.ok(s.pos[1] < y0, 'fell under gravity');
});

test('particles: bounce off the collider', () => {
  const s = new ParticleSystem(1, { max: 8, gravity: -9.8, drag: 0, restitution: 0.6 });
  s.spawn(0, 1, 0, 0, -2, 0, 10);
  let bounced = false;
  for (let i = 0; i < 120; i++) {
    s.step(1 / 60, flat);
    if (s.pos[1] >= 0 && s.vel[1] > 0) { bounced = true; break; }
  }
  assert.ok(bounced, 'bounced upward off the ground');
  // Impact speed was ~4.86; restitution 0.6 must absorb energy.
  assert.ok(s.vel[1] > 0 && s.vel[1] < 4.8, 'restitution absorbed energy');
});

test('particles: life expiry removes them', () => {
  const s = new ParticleSystem(1, { max: 8 });
  s.spawn(0, 0, 0, 0, 0, 0, 0.1);
  s.spawn(0, 0, 0, 0, 0, 0, 10);
  assert.equal(s.count, 2);
  s.step(0.2);
  assert.equal(s.count, 1);
});

test('particles: burst respects max', () => {
  const s = new ParticleSystem(1, { max: 10 });
  s.burst(0, 0, 0, 1, 1, 1, 5, 0, 100);
  assert.equal(s.count, 10);
});

test('particleMesh: writes live particles, hides dead slots', () => {
  const s = new ParticleSystem(1, { max: 4 });
  s.spawn(1, 2, 3, 0, 0, 0, 5);
  const geo = particleGeometry(4);
  writeParticles(geo, s, 0.1);
  // First particle's verts cluster around (1,2,3).
  let cx = 0;
  for (let v = 0; v < 12; v++) cx += geo.positions[v * 3];
  assert.ok(Math.abs(cx / 12 - 1) < 0.11, 'verts near particle x');
  // Dead slots collapsed far below.
  assert.ok(geo.positions[12 * 3 + 1] < -1000, 'dead slot hidden');
  assert.equal(geo.dynamic, true);
});
