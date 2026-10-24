# Inverse city import (v3.2.0)

`src/scene/city.ts` closes the zero-asset doctrine's last open
side: user content. Until now the engine generated every world
from seeds it owned. Now a user can hand it a real city file, and
the engine does with the user's city what it does with its own:
it keeps the math and lets the asset go.

## The flow

1. **Fit once.** `fitCitySpec(input, { name })` reads a city file
   and returns a `CitySpec`. GeoJSON, the engine's layout JSON,
   OBJ, and self-contained glTF enter through separate format
   doors, normalize to one intermediate list of footprint
   polygons and heights (plus street lines when the format
   carries them), and then pass through the same fit. Conversion
   is pure TypeScript; in the demo it runs client-side, in the
   browser, and the file is never uploaded anywhere.
2. **Discard.** The spec is the only thing retained. It contains
   no source coordinate of any kind: no footprint polygon, no
   street polyline, no building position. The suite proves this
   structurally (a recursive walk of the serialized spec asserts
   no coordinate-pair arrays) and by probe (source coordinate
   strings from the fixtures never appear in the spec JSON).
3. **Regenerate.** `buildCity(spec, seed)` grows a sibling city
   from the spec alone, deterministically (grade it with
   `cityDigest`), and the sibling composes through the engine's
   own stacks: `cityLayers` exposes it as a Solid3D SDF layer for
   `marchScene`, and `cityToGrid` rasterizes it into a GridWorld
   the v2.0.3 terrain distance field marches (the demo's render
   path, and the path the suite raycasts).
4. **Blend.** `blendCitySpecs(specs, weights?)` pools fitted
   specs into one mixture spec. The blend regenerates a city
   that is none of the sources and carries their shared
   statistical DNA. Blends read specs only; by then the source
   files are gone, which is the point.

## The format doors

All doors produce `NormalizedCityInput`: buildings as footprint
polygons in meters on the ground plane, each with a height, and
streets as centerline points with a width. `fitCitySpec`
consumes that form only. The public parsers `parseObjCity` and
`parseGltfCity` expose the same normalization for callers that
need to inspect it before fitting.

| Door | Building boundary | Footprint rule | Height rule | Streets |
| --- | --- | --- | --- | --- |
| GeoJSON | One Polygon or MultiPolygon part | The source polygon, projected to a local tangent plane | `height`, else `building:levels` times 3.2 m, else 10 m | LineString and MultiLineString parts |
| Layout JSON | One entry in `buildings` | The rectangle generated from `x`, `z`, `w`, `d`, and `angle` | The entry's `height`, else 10 m | Optional `streets` point lists |
| OBJ | One `o` or `g` group with faces; an ungrouped file is one building | Convex hull of the group's face vertices projected onto the ground plane | Maximum minus minimum along the up axis | None |
| glTF | One scene node carrying a mesh | Convex hull of the mesh position vertices, after the full scene graph transform, projected onto the ground plane | Maximum minus minimum Y after the transform | None |

OBJ details: positive and negative face indices are both
resolved. The default up axis is Y, the format's usual
convention. A Z-up OBJ can be fitted through the API with
`fitCitySpec(text, { objUpAxis: 'z' })`; the importer does not
guess. Face association defines group membership, so vertices
that no face references do not create buildings.

glTF details: the importer accepts JSON with an embedded data
URI buffer and the binary GLB container. Node translation,
rotation, scale, explicit matrices, and children are composed
into a world transform before any vertex is measured. A mesh
reused by several nodes is one building per node instance. A
glTF JSON file whose buffer points to an external file is
rejected with a plain-language error: one file dropped into a
page cannot carry a sidecar, so the supported single-file
forms are embedded glTF and GLB.

## What a CitySpec contains

| Field | Meaning |
| --- | --- |
| `version`, `name`, `origin`, `parents?` | Format version (1), display name, `fit` / `layout` / `blend`, source spec names for blends |
| `extentM { width, depth }` | Source bounding extent, meters |
| `buildingCount`, `densityPerKm2` | Stock size and density |
| `areaMean`, `heightMean` | Exact fitted first moments, meters |
| `footprintArea`, `footprintAspect`, `height` | Probability histograms (edges + weights) over canonical bins |
| `orientation { bins, weights, dominantRad, coherence }` | Long-axis direction histogram over [0, pi), its dominant direction, and a coherence (0 uniform, 1 single direction) |
| `radialProfile`, `densityExponent` | Density ratio per Chebyshev radial ring (6 rings, normalized to average 1) and the least-squares falloff slope |
| `streets { present, lengthDensityPerKm, meanSpacingM, widthM }` | Street length density, the grid-model spacing it implies, mean width |

A fitted spec for the suite's 49-building fixture serializes to
about 1.3 KB; the source file is about 27 KB. The math is small
because the math is all there is.

## The statistics oracle

`measureCity(built, spec)` re-measures a regenerated city against
the spec's binning, and `checkCityStats(spec, stats)` grades it:
histogram L1 distances for footprint area, height, and
orientation against tolerances (0.30 / 0.30 / 0.35), exact
building count, both means within 12%, and radial rings within a
per-ring allowance that widens where the expected building count
is small (a ring expecting two buildings cannot testify to a
tenth of a ratio, and the oracle says so instead of pretending).

Measured on the fixtures (seed sweep 1, 7, 31007, 4242, 99991):
regenerated fitted specs reproduce their histograms exactly
(L1 = 0.000; fit weights are counts over the same n the builder
samples, and the builder's stratified draws land within one count
of target at every bin by construction). The honest mixture case
is the blend: a two-fixture blend regenerates at area L1 0.057,
height L1 0.105, orientation L1 0.133, comfortably inside
tolerance. Determinism digest for fixture A at seed 31007:
`a8137334c5b7129c`; seed 31008 gives a different city that still
passes the oracle.

The mesh fixtures land on the same oracle. The 24-building OBJ
fixture fits to its known area mean 913.3 square meters and
height mean 37.2 m, then regenerates at area, height, and
orientation L1 0.000. The 16-building glTF fixture fits to its
known area mean 952.0 square meters and height mean 32.5 m,
then regenerates at the same three L1 values of 0.000. Those
zeros are expected here, not rounded up from small errors: the
fixtures are rectangular prisms, their values land in the fitted
histogram bins, and stratified regeneration draws the same bin
counts. The embedded glTF and GLB containers fit to identical
specs. The cross-format control authors one 12-building city in
both GeoJSON and OBJ: counts are exact, height means agree
exactly, and area means differ by 0.000029 percent, inside the
stated 1 percent allowance for the GeoJSON tangent projection
and coordinate rounding. An OBJ spec blended with GeoJSON
fixture A regenerates and passes the full statistics oracle at
area L1 0.048, height L1 0.062, and orientation L1 0.065.

Negative controls, in `test/city-import.test.ts` and
`test/city-mesh-import.test.ts`, all required to fail loudly if
the machinery goes soft: a corrupted
spec (height weights collapsed to the top bin) fails the oracle
naming height; a halved building count fails naming count; a
zeroed histogram is refused by `buildCity`; a spatially shuffled
fixture (footprints rotated 90 degrees, heights re-paired) fits
to an orientation histogram 2.000 L1 away from the true fit (the
maximum possible: the rotated grid's mass lands in entirely
different bins) and regenerates with a different dominant
orientation; blending the shuffled spec shifts the blend's
orientation by 1.400 L1; empty,
streets-only, null, and zero-area inputs are rejected with
plain-language errors. For the mesh doors: rotating every OBJ
vertex by 90 degrees moves the fitted orientation by at least
0.5 L1 and changes the dominant bin; collapsing every OBJ
height to one level is rejected with an error naming height;
empty text, text garbage with an OBJ name, and a glTF file
pointing at an external buffer are each rejected plainly; and
the no-source-geometry retention walk runs on both mesh specs.

## Fidelity limits, stated plainly

Regeneration produces a procedural sibling of the source city:
the same distributions, density profile, and orientation field,
in a new arrangement. It is not a copy, and no source building
stands where it stood. Further honest limits:

- Footprint orientation and aspect come from a PCA on each
  polygon's vertices: exact for the rectangular stock that
  dominates real cities, approximate for L-shaped plans.
- Mesh footprints are convex hulls. A concave mesh building is
  fitted as its convex outline, and overhangs do not reduce the
  ground footprint. This is the honest mesh rule for this
  release: the hull is computed from the real projected
  vertices, not from a bounding box, but concavity is not kept.
- OBJ grouping is the building boundary. An ungrouped OBJ is
  one building, and the importer does not classify ground
  planes, props, or other non-building groups separately.
- OBJ is Y-up unless the API caller selects Z-up. glTF is
  Y-up by specification. Neither mesh format supplies the
  street structure the GeoJSON door can carry, so mesh specs
  record streets as absent.
- Street spacing is a grid-model estimate from total street
  length (L/A = 2/s), not a measured block survey. On fixture A
  (true pitch 84 m) the estimator reads 88.6 m.
- Heights fall back to `building:levels` times 3.2 m, then to a
  flat 10 m, when a footprint carries no height. The spec records
  the resulting distribution, not which buildings were guessed.
- Buildings in a regeneration may overlap where the fitted
  distributions say their lots collide. The spec carries
  statistics, not a cadastral map.
- The projection is a local tangent plane about the footprint
  centroid (spherical Earth, R = 6371000). Right for city
  excerpts; wrong for a continent.

## Fixtures and licensing

The suite's fixtures (`test/fixtures/city-a.geojson`,
`city-b.geojson`) are hand-authored in OpenStreetMap data
conventions from the block models in
`test/fixtures/gen-city-fixtures.mjs`: synthetic-but-realistic,
generated rather than scraped, so they carry no ODbL
encumbrance. A live OSM excerpt would be ODbL and would need
attribution; the import path is identical either way, because it
reads the same GeoJSON shape a real export produces. The demo's
bundled sample (`demo/public/sample-city.geojson`) is fixture A
copied so a visitor can try the page without a file.

The mesh fixtures (`mesh-city.obj`, `mesh-city.gltf`,
`mesh-city.glb`, `cross-city.obj`, and `cross-city.geojson`)
are generated by `test/fixtures/gen-city-mesh-fixtures.mjs`
from the explicit block models in that script, with the known
building dimensions recorded in `mesh-models.json`. They are
synthetic fixtures made for this suite, not converted assets.
