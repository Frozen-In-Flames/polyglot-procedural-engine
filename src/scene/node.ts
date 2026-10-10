// scene/node.ts — node graph with parent/child transforms.
import type { Vec3 } from '../math/vec.js';
import { v3 } from '../math/vec.js';
import type { Quat } from '../math/quat.js';
import { qIdentity, toMat4 } from '../math/quat.js';
import type { Mat4 } from '../math/mat.js';
import { identity, multiply, compose } from '../math/mat.js';

export interface Component {
  node: SceneNode | null;
  update?(dt: number, t: number): void;
}

export class SceneNode {
  name: string;
  position: Vec3 = v3();
  rotation: Quat = qIdentity();
  scale: Vec3 = v3(1, 1, 1);
  parent: SceneNode | null = null;
  children: SceneNode[] = [];
  components: Component[] = [];
  visible = true;
  readonly localMatrix: Mat4 = identity();
  readonly worldMatrix: Mat4 = identity();
  private rotMat: Mat4 = new Float32Array(16);
  private dirty = true;

  constructor(name = 'node') {
    this.name = name;
  }

  addChild(child: SceneNode): SceneNode {
    child.parent?.removeChild(child);
    child.parent = this;
    this.children.push(child);
    child.markDirty();
    return child;
  }

  removeChild(child: SceneNode): void {
    const i = this.children.indexOf(child);
    if (i >= 0) {
      this.children.splice(i, 1);
      child.parent = null;
      child.markDirty();
    }
  }

  addComponent<T extends Component>(c: T): T {
    c.node = this;
    this.components.push(c);
    return c;
  }

  markDirty(): void {
    if (this.dirty) return;
    this.dirty = true;
    for (const ch of this.children) ch.markDirty();
  }

  setPosition(x: number, y: number, z: number): this {
    this.position[0] = x; this.position[1] = y; this.position[2] = z;
    this.markDirty();
    return this;
  }

  updateWorldMatrix(parentWorld: Mat4 | null = null): void {
    if (this.dirty) {
      toMat4(this.rotation, this.rotMat);
      compose(this.position, this.rotMat, this.scale, this.localMatrix);
      this.dirty = false;
    }
    if (parentWorld) multiply(parentWorld, this.localMatrix, this.worldMatrix);
    else this.worldMatrix.set(this.localMatrix);
    for (const ch of this.children) ch.updateWorldMatrix(this.worldMatrix);
  }

  update(dt: number, t: number): void {
    for (const c of this.components) c.update?.(dt, t);
    for (const ch of this.children) ch.update(dt, t);
  }

  traverse(fn: (n: SceneNode) => void): void {
    fn(this);
    for (const ch of this.children) ch.traverse(fn);
  }
}
