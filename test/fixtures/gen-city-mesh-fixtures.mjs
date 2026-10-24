// Fixture generator for the v3.2.0 mesh city import suite.
//
// The OBJ and glTF cities are synthetic and hand authored through
// the block models below. They are not scraped or converted from a
// third party asset. Each building is a rectangular prism, so the
// count, footprint area, height, and dominant orientation of every
// fixture are known before any engine code reads the file.
//
// Run from the repository root:
//   node test/fixtures/gen-city-mesh-fixtures.mjs
import { writeFileSync } from 'node:fs';

const dir = new URL('.', import.meta.url).pathname;
const fmt = (v) => Number(v.toFixed(6));

function prismCorners({ x, z, w, d, angle }) {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ].map(([lx, lz]) => [x + lx * ca - lz * sa, z + lx * sa + lz * ca]);
}

function prismVertices(building) {
  const ground = prismCorners(building);
  return [
    ...ground.map(([x, z]) => [x, 0, z]),
    ...ground.map(([x, z]) => [x, building.h, z]),
  ];
}

function writeObj(path, buildings) {
  const lines = [
    '# Synthetic mesh city fixture for the Polyglot Procedural Engine.',
    '# One object per building. Coordinates are meters, Y up.',
  ];
  let index = 1;
  buildings.forEach((b, i) => {
    lines.push(`o Building_${String(i + 1).padStart(3, '0')}`);
    const verts = prismVertices(b);
    for (const [x, y, z] of verts) {
      lines.push(`v ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}`);
    }
    const faces = [
      [1, 4, 3, 2],
      [5, 6, 7, 8],
      [1, 2, 6, 5],
      [2, 3, 7, 6],
      [3, 4, 8, 7],
      [4, 1, 5, 8],
    ];
    for (const face of faces) {
      lines.push(`f ${face.map((n) => n + index - 1).join(' ')}`);
    }
    index += verts.length;
  });
  writeFileSync(path, `${lines.join('\n')}\n`);
}

const R = 6371000;
const M_PER_DEG_LAT = (Math.PI * R) / 180;
function toLonLat(lon0, lat0, east, north) {
  return [
    lon0 + east / (M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180)),
    lat0 + north / M_PER_DEG_LAT,
  ];
}

function writeGeoJson(path, buildings) {
  const lon0 = -97.7431;
  const lat0 = 30.2672;
  const features = buildings.map((b, i) => {
    const ring = prismCorners(b).map(([x, z]) => toLonLat(lon0, lat0, x, -z));
    ring.push(ring[0]);
    return {
      type: 'Feature',
      properties: { building: 'yes', height: b.h, name: `Cross ${i + 1}` },
      geometry: { type: 'Polygon', coordinates: [ring] },
    };
  });
  writeFileSync(path, JSON.stringify({ type: 'FeatureCollection', features }, null, 1));
}

function gridCity({ countX, countZ, pitchX, pitchZ, angle, widths, depths, heights }) {
  const out = [];
  let i = 0;
  for (let rz = 0; rz < countZ; rz++) {
    for (let rx = 0; rx < countX; rx++) {
      out.push({
        x: (rx - (countX - 1) / 2) * pitchX,
        z: (rz - (countZ - 1) / 2) * pitchZ,
        w: widths[i % widths.length],
        d: depths[i % depths.length],
        h: heights[i % heights.length] + rz * 2,
        angle,
      });
      i++;
    }
  }
  return out;
}

const objCity = gridCity({
  countX: 6,
  countZ: 4,
  pitchX: 60,
  pitchZ: 66,
  angle: 0.5,
  widths: [34, 42, 38, 46, 36, 44],
  depths: [18, 24, 21, 27, 20, 25],
  heights: [18, 28, 42, 24, 58, 35],
});

const crossCity = gridCity({
  countX: 4,
  countZ: 3,
  pitchX: 70,
  pitchZ: 64,
  angle: 0.35,
  widths: [36, 44, 40, 32],
  depths: [22, 26, 20, 18],
  heights: [16, 30, 46, 24],
});

const gltfCity = [];
{
  const widths = [34, 42, 38, 46];
  const depths = [20, 25, 22, 27];
  const heights = [16, 30, 44, 24];
  let i = 0;
  for (let district = 0; district < 2; district++) {
    for (let rz = 0; rz < 2; rz++) {
      for (let rx = 0; rx < 4; rx++) {
        gltfCity.push({
          x: (district === 0 ? -90 : 90) + (rx - 1.5) * 60,
          z: (rz - 0.5) * 90,
          w: widths[i % widths.length],
          d: depths[i % depths.length],
          h: heights[i % heights.length] + district * 5 + rz * 3,
          angle: 1.1,
        });
        i++;
      }
    }
  }
}

function gltfDocument(bufferUri) {
  const positions = new Float32Array([
    -0.5, 0, -0.5,
    0.5, 0, -0.5,
    0.5, 0, 0.5,
    -0.5, 0, 0.5,
    -0.5, 1, -0.5,
    0.5, 1, -0.5,
    0.5, 1, 0.5,
    -0.5, 1, 0.5,
  ]);
  const indices = new Uint16Array([
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6,
    3, 0, 4, 3, 4, 7,
  ]);
  const positionBytes = Buffer.from(positions.buffer);
  const indexBytes = Buffer.from(indices.buffer);
  const bin = Buffer.concat([positionBytes, indexBytes]);
  const angle = 1.1;
  const quat = [0, Math.sin(-angle / 2), 0, Math.cos(-angle / 2)];
  const nodes = [
    { name: 'West district', translation: [-90, 0, 0], children: [] },
    { name: 'East district', translation: [90, 0, 0], children: [] },
  ];
  gltfCity.forEach((b, i) => {
    const district = i < 8 ? 0 : 1;
    const nodeIndex = nodes.length;
    nodes[district].children.push(nodeIndex);
    nodes.push({
      name: `Building ${i + 1}`,
      mesh: 0,
      translation: [b.x - (district === 0 ? -90 : 90), 0, b.z],
      rotation: quat,
      scale: [b.w, b.h, b.d],
    });
  });
  const doc = {
    asset: { version: '2.0', generator: 'PPE synthetic fixture generator' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes,
    meshes: [{
      name: 'Unit prism',
      primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4 }],
    }],
    buffers: [{ byteLength: bin.length, ...(bufferUri ? { uri: bufferUri(bin) } : {}) }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.length, target: 34962 },
      { buffer: 0, byteOffset: positionBytes.length, byteLength: indexBytes.length, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0, componentType: 5126, count: 8, type: 'VEC3',
        min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5],
      },
      { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
  };
  return { doc, bin };
}

const embedded = gltfDocument((bin) =>
  `data:application/octet-stream;base64,${bin.toString('base64')}`);
writeFileSync(dir + 'mesh-city.gltf', JSON.stringify(embedded.doc, null, 1));

const glbParts = gltfDocument(null);
{
  const json = Buffer.from(JSON.stringify(glbParts.doc));
  const jsonPadded = Buffer.concat([
    json,
    Buffer.alloc((4 - (json.length % 4)) % 4, 0x20),
  ]);
  const binPadded = Buffer.concat([
    glbParts.bin,
    Buffer.alloc((4 - (glbParts.bin.length % 4)) % 4),
  ]);
  const total = 12 + 8 + jsonPadded.length + 8 + binPadded.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonPadded.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonPadded.copy(out, 20);
  const binAt = 20 + jsonPadded.length;
  out.writeUInt32LE(binPadded.length, binAt);
  out.writeUInt32LE(0x004e4942, binAt + 4);
  binPadded.copy(out, binAt + 8);
  writeFileSync(dir + 'mesh-city.glb', out);
}

writeObj(dir + 'mesh-city.obj', objCity);
writeObj(dir + 'cross-city.obj', crossCity);
writeGeoJson(dir + 'cross-city.geojson', crossCity);
writeFileSync(dir + 'mesh-models.json', JSON.stringify({
  obj: objCity.map((b) => ({ ...b, area: fmt(b.w * b.d) })),
  gltf: gltfCity.map((b) => ({ ...b, area: fmt(b.w * b.d) })),
  cross: crossCity.map((b) => ({ ...b, area: fmt(b.w * b.d) })),
}, null, 1));

console.log(`mesh-city.obj: ${objCity.length} buildings`);
console.log(`mesh-city.gltf/glb: ${gltfCity.length} buildings`);
console.log(`cross city: ${crossCity.length} buildings in GeoJSON and OBJ`);
