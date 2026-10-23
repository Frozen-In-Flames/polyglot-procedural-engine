// Fixture generator for the v3.1.0 city-import suite. Run once,
// outputs are committed; the suite reads the committed GeoJSON.
//
// These are hand-authored excerpts in OpenStreetMap data conventions
// (GeoJSON, building footprint polygons with a `height` property in
// meters, highway LineStrings), modeled on real downtown block
// patterns. They are synthetic-but-realistic: the coordinates are
// generated from the block models below, not scraped, so they carry
// no ODbL encumbrance. (Live OSM excerpts would be ODbL and would
// need attribution; the import code path is identical either way:
// it reads the same GeoJSON shape a real export produces.)
import { writeFileSync } from 'node:fs';

// Small deterministic LCG (fixture generation only; the engine
// itself uses the canonical Pcg32).
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const R = 6371000;
const M_PER_DEG_LAT = (Math.PI * R) / 180;

function toLonLat(lon0, lat0, east, north) {
  const lon = lon0 + east / (M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180));
  const lat = lat0 + north / M_PER_DEG_LAT;
  return [Number(lon.toFixed(7)), Number(lat.toFixed(7))];
}

// Build a rectangular footprint in a rotated grid frame.
// cx, cy: center in grid-frame meters. w, d: size along grid axes.
// angle: grid rotation in radians (frame -> east/north).
function rectPolygon(lon0, lat0, cx, cy, w, d, angle, jitter, rnd) {
  const a = angle + jitter;
  const ca = Math.cos(a), sa = Math.sin(a);
  const hw = w / 2, hd = d / 2;
  const corners = [
    [-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd], [-hw, -hd],
  ].map(([lx, ly]) => {
    const east = cx + lx * ca - ly * sa;
    const north = cy + lx * sa + ly * ca;
    return toLonLat(lon0, lat0, east, north);
  });
  return corners;
}

function streetLine(lon0, lat0, pts, angle) {
  const ca = Math.cos(angle), sa = Math.sin(angle);
  return pts.map(([lx, ly]) =>
    toLonLat(lon0, lat0, lx * ca - ly * sa, lx * sa + ly * ca));
}

function makeCity(cfg) {
  const rnd = lcg(cfg.seed);
  const features = [];
  const { lon0, lat0, angle, pitchX, pitchZ, nx, nz, streetWidth } = cfg;
  // Buildings: 1..maxPerBlock per block, placed on a jittered
  // sub-lot layout inside the block's buildable area.
  for (let bx = 0; bx < nx; bx++) {
    for (let bz = 0; bz < nz; bz++) {
      const blockCx = (bx - (nx - 1) / 2) * pitchX;
      const blockCy = (bz - (nz - 1) / 2) * pitchZ;
      const innerW = pitchX - streetWidth - 6;
      const innerD = pitchZ - streetWidth - 6;
      const n = 1 + Math.floor(rnd() * cfg.maxPerBlock);
      for (let k = 0; k < n; k++) {
        // Sub-lot: split the block into n lots along x.
        const lotW = innerW / n;
        const cx = blockCx - innerW / 2 + lotW * (k + 0.5) + (rnd() - 0.5) * 3;
        const cy = blockCy + (rnd() - 0.5) * (innerD * 0.3);
        const w = lotW * (0.55 + rnd() * 0.35);
        const d = Math.min(innerD * (0.5 + rnd() * 0.4), innerD * 0.9);
        const tower = rnd() < cfg.towerProb;
        const height = tower
          ? cfg.towerH[0] + rnd() * (cfg.towerH[1] - cfg.towerH[0])
          : cfg.baseH[0] + rnd() * (cfg.baseH[1] - cfg.baseH[0]);
        features.push({
          type: 'Feature',
          properties: {
            building: 'yes',
            height: Number(height.toFixed(1)),
            name: `${cfg.tag} ${bx}-${bz}-${k}`,
          },
          geometry: {
            type: 'Polygon',
            coordinates: [rectPolygon(lon0, lat0, cx, cy, w, d, angle, (rnd() - 0.5) * 0.05, rnd)],
          },
        });
      }
    }
  }
  // Streets along the grid lines.
  const xExtent = (nx * pitchX) / 2 + 12;
  const zExtent = (nz * pitchZ) / 2 + 12;
  for (let i = 0; i <= nx; i++) {
    const x = (i - nx / 2) * pitchX;
    features.push({
      type: 'Feature',
      properties: { highway: 'residential', width: streetWidth },
      geometry: {
        type: 'LineString',
        coordinates: streetLine(lon0, lat0, [[x, -zExtent], [x, zExtent]], angle),
      },
    });
  }
  for (let j = 0; j <= nz; j++) {
    const z = (j - nz / 2) * pitchZ;
    features.push({
      type: 'Feature',
      properties: { highway: 'residential', width: streetWidth },
      geometry: {
        type: 'LineString',
        coordinates: streetLine(lon0, lat0, [[-xExtent, z], [xExtent, z]], angle),
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

// Fixture A: dense downtown grid, towers, tight blocks.
const cityA = makeCity({
  tag: 'A', seed: 1177,
  lon0: -97.7431, lat0: 30.2672, angle: (-8 * Math.PI) / 180,
  pitchX: 84, pitchZ: 84, nx: 5, nz: 4, streetWidth: 18,
  maxPerBlock: 4, baseH: [12, 45], towerH: [60, 115], towerProb: 0.22,
});
// Fixture B: low-rise garden district, larger lots, stronger rotation.
const cityB = makeCity({
  tag: 'B', seed: 9241,
  lon0: -97.7612, lat0: 30.2841, angle: (38 * Math.PI) / 180,
  pitchX: 120, pitchZ: 105, nx: 4, nz: 3, streetWidth: 12,
  maxPerBlock: 2, baseH: [6, 18], towerH: [20, 26], towerProb: 0.08,
});

const dir = new URL('.', import.meta.url).pathname;
writeFileSync(dir + 'city-a.geojson', JSON.stringify(cityA, null, 1));
writeFileSync(dir + 'city-b.geojson', JSON.stringify(cityB, null, 1));
const count = (c) => c.features.filter((f) => f.geometry.type === 'Polygon').length;
console.log(`city-a: ${count(cityA)} buildings, ${cityA.features.length} features`);
console.log(`city-b: ${count(cityB)} buildings, ${cityB.features.length} features`);
