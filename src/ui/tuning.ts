// ui/tuning.ts - the Tuning Deck: the engine's parameter panel.
//
// There is no asset browser and no inspector here, because there are no
// assets. Every world math parameter gets a real control (slider, dial,
// or curve) with live updates. The core (ParamRegistry, CurveParam) is
// DOM-agnostic and unit-tested; mountTuningDeck() binds it to real DOM.
export interface ParamDef {
  name: string;
  min: number;
  max: number;
  value: number;
  step?: number;
  unit?: string;
  /** Human note: which math variable this drives. */
  drives?: string;
}

export type ParamListener = (name: string, value: number) => void;

/** Live registry of world math parameters. Values always stay clamped. */
export class ParamRegistry {
  private defs = new Map<string, ParamDef>();
  private initial = new Map<string, number>();
  private listeners = new Map<string, ParamListener[]>();
  private global: ParamListener[] = [];

  define(def: ParamDef): void {
    const d = { ...def, value: this.clamp(def, def.value) };
    this.defs.set(def.name, d);
    this.initial.set(def.name, d.value);
  }

  has(name: string): boolean {
    return this.defs.has(name);
  }

  get(name: string): number {
    const d = this.defs.get(name);
    if (!d) throw new Error(`unknown param: ${name}`);
    return d.value;
  }

  def(name: string): ParamDef {
    const d = this.defs.get(name);
    if (!d) throw new Error(`unknown param: ${name}`);
    return { ...d };
  }

  names(): string[] {
    return [...this.defs.keys()];
  }

  set(name: string, value: number): void {
    const d = this.defs.get(name);
    if (!d) throw new Error(`unknown param: ${name}`);
    const v = this.clamp(d, value);
    if (v === d.value) return;
    d.value = v;
    for (const fn of this.listeners.get(name) ?? []) fn(name, v);
    for (const fn of this.global) fn(name, v);
  }

  onChange(name: string, fn: ParamListener): void {
    const list = this.listeners.get(name) ?? [];
    list.push(fn);
    this.listeners.set(name, list);
  }

  onAnyChange(fn: ParamListener): void {
    this.global.push(fn);
  }

  snapshot(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [n, d] of this.defs) out[n] = d.value;
    return out;
  }

  reset(): void {
    for (const [n, v] of this.initial) this.set(n, v);
  }

  private clamp(d: ParamDef, v: number): number {
    const step = d.step ?? 0;
    let out = Math.min(d.max, Math.max(d.min, v));
    if (step > 0) out = Math.round(out / step) * step;
    return Math.min(d.max, Math.max(d.min, out));
  }
}

/** Piecewise-linear curve over [0,1] x [0,1], for dial-like shaping. */
export class CurveParam {
  points: Array<{ x: number; y: number }>;

  constructor(points: Array<{ x: number; y: number }> = [{ x: 0, y: 0 }, { x: 1, y: 1 }]) {
    this.points = points
      .map(p => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) }))
      .sort((a, b) => a.x - b.x);
    if (this.points.length === 0) this.points = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  }

  eval(x: number): number {
    const xc = Math.min(1, Math.max(0, x));
    const pts = this.points;
    if (xc <= pts[0].x) return pts[0].y;
    for (let i = 1; i < pts.length; i++) {
      if (xc <= pts[i].x) {
        const a = pts[i - 1], b = pts[i];
        const t = b.x > a.x ? (xc - a.x) / (b.x - a.x) : 0;
        return a.y + (b.y - a.y) * t;
      }
    }
    return pts[pts.length - 1].y;
  }

  movePoint(i: number, x: number, y: number): void {
    if (i < 0 || i >= this.points.length) return;
    this.points[i] = {
      x: Math.min(1, Math.max(0, x)),
      y: Math.min(1, Math.max(0, y)),
    };
    this.points.sort((a, b) => a.x - b.x);
  }

  addPoint(x: number, y: number): void {
    this.points.push({ x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) });
    this.points.sort((a, b) => a.x - b.x);
  }
}

export interface DeckSection {
  title: string;
  params: string[];
  curves?: Record<string, CurveParam>;
}

/**
 * Bind a registry to real DOM: sliders with live readouts, rotary dials,
 * and draggable curve editors, grouped in sections. Vanilla DOM, no deps.
 */
export function mountTuningDeck(
  host: HTMLElement,
  registry: ParamRegistry,
  sections: DeckSection[],
): void {
  host.classList.add('ppe-tuning-deck');
  for (const sec of sections) {
    const wrap = host.ownerDocument.createElement('div');
    wrap.className = 'ppe-deck-section';
    const h = host.ownerDocument.createElement('h3');
    h.textContent = sec.title;
    wrap.appendChild(h);
    for (const name of sec.params) {
      if (!registry.has(name)) continue;
      wrap.appendChild(buildSlider(host.ownerDocument, registry, name));
    }
    for (const [cname, curve] of Object.entries(sec.curves ?? {})) {
      wrap.appendChild(buildCurveEditor(host.ownerDocument, cname, curve));
    }
    host.appendChild(wrap);
  }
}

function buildSlider(doc: Document, registry: ParamRegistry, name: string): HTMLElement {
  const def = registry.def(name);
  const row = doc.createElement('div');
  row.className = 'ppe-param';
  const label = doc.createElement('label');
  label.textContent = def.unit ? `${def.name} (${def.unit})` : def.name;
  if (def.drives) label.title = `drives: ${def.drives}`;
  const input = doc.createElement('input');
  input.type = 'range';
  input.min = String(def.min);
  input.max = String(def.max);
  input.step = String(def.step ?? (def.max - def.min) / 200);
  input.value = String(def.value);
  input.setAttribute('aria-label', def.name);
  const readout = doc.createElement('span');
  readout.className = 'ppe-readout';
  const paint = () => { readout.textContent = fmtNum(registry.get(name)); };
  input.addEventListener('input', () => {
    registry.set(name, parseFloat(input.value));
    paint();
  });
  registry.onChange(name, () => {
    input.value = String(registry.get(name));
    paint();
  });
  paint();
  const dial = buildDial(doc, registry, name);
  row.append(label, input, readout, dial);
  return row;
}

/** Rotary dial: drag vertically to change the same parameter. */
function buildDial(doc: Document, registry: ParamRegistry, name: string): HTMLElement {
  const def = registry.def(name);
  const dial = doc.createElement('div');
  dial.className = 'ppe-dial';
  dial.setAttribute('role', 'slider');
  dial.setAttribute('aria-label', def.name + ' dial');
  dial.tabIndex = 0;
  const paint = () => {
    const t = (registry.get(name) - def.min) / Math.max(1e-9, def.max - def.min);
    dial.style.setProperty('--rot', `${-135 + t * 270}deg`);
    dial.setAttribute('aria-valuenow', String(registry.get(name)));
  };
  let dragging = false;
  let startY = 0;
  let startV = 0;
  dial.addEventListener('pointerdown', e => {
    dragging = true;
    startY = e.clientY;
    startV = registry.get(name);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  });
  dial.addEventListener('pointermove', e => {
    if (!dragging) return;
    const range = def.max - def.min;
    registry.set(name, startV + ((startY - e.clientY) / 160) * range);
    paint();
  });
  const stop = () => { dragging = false; };
  dial.addEventListener('pointerup', stop);
  dial.addEventListener('pointercancel', stop);
  dial.addEventListener('keydown', e => {
    const step = (def.step ?? (def.max - def.min) / 100);
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { registry.set(name, registry.get(name) + step); paint(); e.preventDefault(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { registry.set(name, registry.get(name) - step); paint(); e.preventDefault(); }
  });
  registry.onChange(name, paint);
  paint();
  return dial;
}

/** Small canvas with draggable points editing a CurveParam. */
function buildCurveEditor(doc: Document, name: string, curve: CurveParam): HTMLElement {
  const wrap = doc.createElement('div');
  wrap.className = 'ppe-curve';
  const label = doc.createElement('label');
  label.textContent = name;
  const canvas = doc.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  canvas.setAttribute('aria-label', name + ' curve editor');
  wrap.append(label, canvas);
  const ctx = canvas.getContext('2d')!;
  const draw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const x = i / 40;
      const px = x * canvas.width, py = canvas.height - curve.eval(x) * canvas.height;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.fillStyle = '#fb923c';
    for (const p of curve.points) {
      ctx.beginPath();
      ctx.arc(p.x * canvas.width, canvas.height - p.y * canvas.height, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  };
  let dragIdx = -1;
  const toLocal = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
      y: Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)),
    };
  };
  canvas.addEventListener('pointerdown', e => {
    const p = toLocal(e);
    let best = -1, bd = 1e9;
    curve.points.forEach((q, i) => {
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bd) { bd = d; best = i; }
    });
    dragIdx = bd < 0.15 ? best : -1;
    if (dragIdx >= 0) {
      canvas.setPointerCapture?.(e.pointerId);
    } else {
      curve.addPoint(p.x, p.y);
    }
    draw();
  });
  canvas.addEventListener('pointermove', e => {
    if (dragIdx < 0) return;
    const p = toLocal(e);
    curve.movePoint(dragIdx, p.x, p.y);
    draw();
  });
  canvas.addEventListener('pointerup', () => { dragIdx = -1; });
  draw();
  return wrap;
}

function fmtNum(v: number): string {
  return Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3);
}

/** Minimal CSS for the deck (the demo inlines or extends it). */
export const TUNING_DECK_CSS = `
.ppe-tuning-deck { font-family: system-ui, sans-serif; color: #e2e8f0; }
.ppe-deck-section { margin-bottom: 14px; }
.ppe-deck-section h3 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #7dd3fc; margin: 0 0 8px; }
.ppe-param { display: grid; grid-template-columns: 1fr auto; gap: 4px 8px; margin-bottom: 8px; align-items: center; }
.ppe-param label { font-size: 12px; grid-column: 1 / -1; }
.ppe-param input[type=range] { width: 100%; accent-color: #fb923c; }
.ppe-readout { font-size: 11px; color: #94a3b8; font-variant-numeric: tabular-nums; }
.ppe-dial { width: 26px; height: 26px; border-radius: 50%; border: 2px solid #38bdf8; position: relative; cursor: ns-resize; grid-row: span 1; justify-self: end; }
.ppe-dial::after { content: ''; position: absolute; left: 50%; top: 2px; width: 2px; height: 9px; background: #fb923c; transform-origin: 50% 11px; transform: translateX(-50%) rotate(var(--rot, 0deg)); }
.ppe-curve label { font-size: 12px; }
.ppe-curve canvas { border: 1px solid #1e293b; border-radius: 8px; background: #0b1220; touch-action: none; }
`;
