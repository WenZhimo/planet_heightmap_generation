// Planet mesh construction: Voronoi geometry, map projection, overlays.

import * as THREE from 'three';
import { renderer, scene, waterMesh, atmosMesh, starsMesh } from './scene.js';
import { state } from './state.js';
import { elevationToColor, elevToHeightKm, biomeColor } from './color-map.js';
import { makeRng } from './rng.js';
import { KOPPEN_CLASSES } from './koppen.js';
import { createMapProjectionProjector, getMapProjectionParams, projectMapDirectionFromXyz, projectMapSegmentFromLonLat, writeProjectedMapSegmentFromLonLat, writeProjectedMapSegmentFromXyz, writeProjectedMapTriangleFromXyz } from './map-projection.js';
import { createZipBlob, downloadBlob } from './zip-util.js';

// Clipping planes for map wrap — keep everything within x ∈ [-2, 2]
renderer.localClippingEnabled = true;
const MAP_CLIP_PLANES = [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), 2),   // x >= -2
    new THREE.Plane(new THREE.Vector3(-1, 0, 0), 2),   // x <= 2
];
const MAP_PROJECTION_PREVIEW_MAX_SIDES = 24000;

// Precompute smoothed biome colors: each region blends with its neighbors' average.
// Uses mesh adjacency (~6 neighbors per region) so it's inherently scale-independent.
// Cached on state to avoid redundant computation across render paths.
let _biomeCache = null;
let _biomeCacheKey = null;

function getCachedBiomeSmoothed(mesh, koppenArr, r_elevation) {
    if (_biomeCache && _biomeCacheKey === koppenArr) return _biomeCache;
    _biomeCache = smoothBiomeColors(mesh, koppenArr, r_elevation);
    _biomeCacheKey = koppenArr;
    return _biomeCache;
}

function smoothBiomeColors(mesh, koppenArr, r_elevation) {
    const n = mesh.numRegions;
    const raw = new Float32Array(n * 3);
    for (let r = 0; r < n; r++) {
        const [cr, cg, cb] = biomeColor(koppenArr[r], r_elevation[r]);
        raw[r * 3] = cr; raw[r * 3 + 1] = cg; raw[r * 3 + 2] = cb;
    }
    const out = new Float32Array(n * 3);
    const alpha = 0.35;
    const { adjOffset, adjList } = mesh;
    for (let r = 0; r < n; r++) {
        const start = adjOffset[r];
        const end = adjOffset[r + 1];
        const count = end - start;
        if (count === 0) {
            out[r * 3] = raw[r * 3]; out[r * 3 + 1] = raw[r * 3 + 1]; out[r * 3 + 2] = raw[r * 3 + 2];
            continue;
        }
        let avgR = 0, avgG = 0, avgB = 0;
        for (let i = start; i < end; i++) {
            const nr = adjList[i];
            avgR += raw[nr * 3]; avgG += raw[nr * 3 + 1]; avgB += raw[nr * 3 + 2];
        }
        avgR /= count; avgG /= count; avgB /= count;
        out[r * 3]     = raw[r * 3]     * (1 - alpha) + avgR * alpha;
        out[r * 3 + 1] = raw[r * 3 + 1] * (1 - alpha) + avgG * alpha;
        out[r * 3 + 2] = raw[r * 3 + 2] * (1 - alpha) + avgB * alpha;
    }
    return out;
}

// Grayscale heightmap: black (lowest) → white (highest), in physical height space
// Absolute-scale heightmap: fixed range -5 km (deep ocean) → 6 km (tallest peak)
// so the same physical height always maps to the same shade regardless of planet.
function heightmapColor(elevation) {
    const h = elevToHeightKm(elevation);
    const t = Math.max(0, Math.min(1, (h + 5) / 11)); // -5 → 0, 6 → 1
    return [t, t, t];
}

// Land heightmap: ocean = black, land = 0 → 6 km absolute scale
function landHeightmapColor(elevation) {
    if (elevation <= 0) return [0, 0, 0];
    const t = Math.max(0, Math.min(1, elevToHeightKm(elevation) / 6));
    return [t, t, t];
}

// Land mask: white = land, black = ocean
function landMaskColor(elevation) {
    return elevation > 0 ? [1, 1, 1] : [0, 0, 0];
}

// ── 16-bit grayscale PNG encoder ────────────────────────────────────
// Produces a standard 16-bit grayscale PNG (bit depth 16, color type 0)
// using the browser's CompressionStream API for zlib compression.

const _crc32Table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c;
    }
    return t;
})();

function _crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = _crc32Table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function _pngChunk(type, data) {
    const chunk = new Uint8Array(4 + 4 + data.length + 4);
    const dv = new DataView(chunk.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
    chunk.set(data, 8);
    dv.setUint32(8 + data.length, _crc32(chunk.subarray(4, 8 + data.length)));
    return chunk;
}

async function encode16BitGrayscalePNG(width, height, data16) {
    // IHDR: width, height, bit depth 16, color type 0 (grayscale)
    const ihdr = new Uint8Array(13);
    const iv = new DataView(ihdr.buffer);
    iv.setUint32(0, width);
    iv.setUint32(4, height);
    ihdr[8] = 16; ihdr[9] = 0; // 16-bit grayscale

    // Raw scanlines: filter byte (0=None) + width×2 bytes per row
    const rowLen = 1 + width * 2;
    const raw = new Uint8Array(height * rowLen);
    for (let y = 0; y < height; y++) {
        const off = y * rowLen;
        raw[off] = 0; // filter: None
        for (let x = 0; x < width; x++) {
            const v = data16[y * width + x];
            raw[off + 1 + x * 2] = (v >> 8) & 0xFF;
            raw[off + 1 + x * 2 + 1] = v & 0xFF;
        }
    }

    // Compress with zlib (CompressionStream 'deflate' = zlib format)
    const cs = new CompressionStream('deflate');
    const writer = cs.writable.getWriter();
    writer.write(raw);
    writer.close();
    const compData = new Uint8Array(await new Response(cs.readable).arrayBuffer());

    // Assemble PNG
    const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const ihdrC = _pngChunk('IHDR', ihdr);
    const idatC = _pngChunk('IDAT', compData);
    const iendC = _pngChunk('IEND', new Uint8Array(0));

    const png = new Uint8Array(sig.length + ihdrC.length + idatC.length + iendC.length);
    let p = 0;
    png.set(sig, p); p += sig.length;
    png.set(ihdrC, p); p += ihdrC.length;
    png.set(idatC, p); p += idatC.length;
    png.set(iendC, p);

    return new Blob([png], { type: 'image/png' });
}

// ────────────────────────────────────────────────────────────────────

// Diverging color map: blue (negative) → white (zero) → red (positive)
function debugValueToColor(v, minV, maxV) {
    const range = Math.max(Math.abs(minV), Math.abs(maxV)) || 1;
    const t = Math.max(-1, Math.min(1, v / range)); // normalise to [-1, 1]
    if (t < 0) {
        const s = -t; // 0→1
        return [1 - s * 0.7, 1 - s * 0.7, 1];           // white → blue
    } else {
        const s = t;  // 0→1
        return [1, 1 - s * 0.75, 1 - s * 0.75];          // white → red
    }
}

// Precipitation debug color: brown (dry) → green (moderate) → blue (wet)
function precipitationColor(value) {
    // value is 0–1 (p95-normalized)
    const t = Math.max(0, Math.min(1, value));
    if (t < 0.25) {
        // Very dry: tan/brown
        const s = t / 0.25;
        return [0.76 - s * 0.16, 0.60 - s * 0.05, 0.42 - s * 0.12];
    } else if (t < 0.5) {
        // Dry to moderate: brown → green
        const s = (t - 0.25) / 0.25;
        return [0.60 - s * 0.30, 0.55 + s * 0.20, 0.30 - s * 0.05];
    } else if (t < 0.75) {
        // Moderate to wet: green → teal
        const s = (t - 0.5) / 0.25;
        return [0.30 - s * 0.15, 0.75 - s * 0.10, 0.25 + s * 0.40];
    } else {
        // Wet to very wet: teal → deep blue
        const s = (t - 0.75) / 0.25;
        return [0.15 - s * 0.05, 0.65 - s * 0.35, 0.65 + s * 0.20];
    }
}

// Rain shadow diverging color: blue (windward boost) ↔ neutral gray ↔ red-brown (leeward shadow)
// Input is signed: positive = windward, negative = leeward shadow (propagated downwind)
function rainShadowColor(value) {
    if (value > 0.01) {
        // Windward: gray → blue (saturates at 0.5)
        const t = Math.min(1, value / 0.5);
        return [0.55 - t * 0.40, 0.55 - t * 0.10, 0.58 + t * 0.37];
    } else if (value < -0.01) {
        // Leeward shadow: gray → red-brown (saturates at -0.5)
        const t = Math.min(1, -value / 0.5);
        return [0.55 + t * 0.35, 0.55 - t * 0.35, 0.58 - t * 0.45];
    }
    return [0.55, 0.55, 0.58]; // neutral gray (ocean / flat)
}

// Continentality debug color: ocean (blue) → coast (green) → interior (orange/red)
// Input is 0–1: 0 = open ocean, ~0.3-0.5 = coast, 0.95+ = deep interior.
function continentalityColor(value) {
    const t = Math.max(0, Math.min(1, value));
    if (t < 0.15) {
        // Ocean: dark blue → lighter blue
        const s = t / 0.15;
        return [0.05 + s * 0.10, 0.10 + s * 0.20, 0.40 + s * 0.20];
    } else if (t < 0.4) {
        // Coastal: blue → green
        const s = (t - 0.15) / 0.25;
        return [0.15 - s * 0.05, 0.30 + s * 0.45, 0.60 - s * 0.35];
    } else if (t < 0.7) {
        // Moderate interior: green → yellow
        const s = (t - 0.4) / 0.3;
        return [0.10 + s * 0.80, 0.75 - s * 0.05, 0.25 - s * 0.15];
    } else if (t < 0.9) {
        // Deep interior: yellow → orange
        const s = (t - 0.7) / 0.2;
        return [0.90 + s * 0.05, 0.70 - s * 0.40, 0.10 - s * 0.05];
    } else {
        // Super-continent core: orange → dark red
        const s = (t - 0.9) / 0.1;
        return [0.95 - s * 0.25, 0.30 - s * 0.20, 0.05];
    }
}

// Temperature continentality zones: 5 discrete colors matching the guide's zones.
// 0.0 = Hyperoceanic (deep blue), 0.25 = Oceanic (teal), 0.5 = Subcontinental (green),
// 0.75 = Continental (orange), 1.0 = Hypercontinental (red). Smoothed values interpolate.
function tempContinentalityColor(value) {
    // Ocean cells stored as -1 → clean dark blue
    if (value < 0) return [0.06, 0.08, 0.22];
    const t = Math.max(0, Math.min(1, value));
    // 5 zone colors
    const zones = [
        [0.10, 0.20, 0.65],  // Hyperoceanic: deep blue
        [0.15, 0.55, 0.65],  // Oceanic: teal
        [0.30, 0.70, 0.25],  // Subcontinental: green
        [0.85, 0.60, 0.15],  // Continental: orange
        [0.80, 0.15, 0.10],  // Hypercontinental: red
    ];
    const idx = t * 4; // 0..4
    const lo = Math.min(Math.floor(idx), 3);
    const hi = lo + 1;
    const f = idx - lo;
    return [
        zones[lo][0] + (zones[hi][0] - zones[lo][0]) * f,
        zones[lo][1] + (zones[hi][1] - zones[lo][1]) * f,
        zones[lo][2] + (zones[hi][2] - zones[lo][2]) * f,
    ];
}

// Temperature debug color: discrete bands matching real climate map style.
// Input is 0-1 normalized from -45 to +45 C. Convert back to C for thresholds.
function temperatureColor(value) {
    const T = -45 + Math.max(0, Math.min(1, value)) * 90;
    if (T < -38) return [0.78, 0.78, 0.78];       // White-gray
    if (T <   0) return [0.00, 0.00, 0.50];        // Dark blue
    if (T <  10) return [0.53, 0.81, 0.92];        // Light blue
    if (T <  18) return [1.00, 1.00, 0.00];        // Yellow
    if (T <  22) return [1.00, 0.65, 0.00];        // Orange
    if (T <  32) return [1.00, 0.00, 0.00];        // Red
    if (T <  40) return [0.55, 0.00, 0.00];        // Dark red
    return [0.20, 0.00, 0.00];                      // Darker red
}

// Köppen climate class color: returns [r,g,b] from KOPPEN_CLASSES lookup.
function koppenColor(classId) {
    const c = KOPPEN_CLASSES[classId] || KOPPEN_CLASSES[0];
    return c.color;
}

// Plate colours — green shades for land, blue for ocean.
export function computePlateColors(plateSeeds, plateIsOcean) {
    state.plateColors = {};
    for (const r of plateSeeds) {
        const rng = makeRng(r);
        if (plateIsOcean.has(r)) {
            const h = 0.55 + rng() * 0.10;
            const s = 0.40 + rng() * 0.30;
            const l = 0.35 + rng() * 0.20;
            state.plateColors[r] = new THREE.Color().setHSL(h, s, l);
        } else {
            const h = 0.25 + rng() * 0.15;
            const s = 0.30 + rng() * 0.30;
            const l = 0.30 + rng() * 0.20;
            state.plateColors[r] = new THREE.Color().setHSL(h, s, l);
        }
    }
}

function resetMapHighlightBackups() {
    state._mapHoverBackup = null;
    state._mapKoppenHoverBackup = null;
    state._mapPendingBackup = null;
}

function setStableMapBounds(geo) {
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 8);
}

function projectedTriangleCapacity(numSides) {
    return numSides * 2;
}

function clearMapProjectionCache() {
    state._mapTriangleXyz = null;
    state._mapTriangleColors = null;
    state._mapTriangleCount = 0;
    state._mapTriangleCapacity = 0;
    state._mapFaceToSideBuffer = null;
    clearMapProjectionPreview();
}

function clearMapProjectionPreview() {
    if (state.mapProjectionPreviewMesh) {
        scene.remove(state.mapProjectionPreviewMesh);
        state.mapProjectionPreviewMesh.geometry.dispose();
        state.mapProjectionPreviewMesh.material.dispose();
        state.mapProjectionPreviewMesh = null;
    }
    state._mapPreviewTriangleXyz = null;
    state._mapPreviewTriangleColors = null;
    state._mapPreviewTriangleCount = 0;
    state._mapPreviewFaceToSideBuffer = null;
}

function updateProjectedTriangleMesh(targetMesh, sourceXyz, sourceColors, sourceCount, faceToSideBuffer, params, commitFaceMap) {
    if (!targetMesh || !sourceXyz || !sourceColors || !faceToSideBuffer) return false;
    const geo = targetMesh.geometry;
    const posAttr = geo.getAttribute('position');
    const colorAttr = geo.getAttribute('color');
    if (!posAttr || !colorAttr) return false;

    const positions = posAttr.array;
    const colors = colorAttr.array;
    const maxTriCount = Math.min(faceToSideBuffer.length, Math.floor(positions.length / 9), Math.floor(colors.length / 9));
    const totalSources = sourceCount || Math.floor(sourceXyz.length / 9);
    const projector = createMapProjectionProjector(params);
    let triCount = 0;

    for (let s = 0; s < totalSources; s++) {
        const src = s * 9;
        if (triCount + 2 > maxTriCount) break;
        const added = writeProjectedMapTriangleFromXyz(projector, sourceXyz, src, positions, triCount * 9, 0);
        for (let i = 0; i < added; i++) {
            const off = triCount * 9;
            for (let j = 0; j < 9; j++) colors[off + j] = sourceColors[src + j];
            faceToSideBuffer[triCount] = s;
            triCount++;
        }
    }

    geo.setDrawRange(0, triCount * 3);
    posAttr.needsUpdate = true;
    colorAttr.needsUpdate = true;
    if (commitFaceMap) {
        state.mapFaceToSide = faceToSideBuffer.subarray(0, triCount);
        resetMapHighlightBackups();
    }
    return true;
}

export function updateMapMeshProjection(params = getMapProjectionParams()) {
    return updateProjectedTriangleMesh(
        state.mapMesh,
        state._mapTriangleXyz,
        state._mapTriangleColors,
        state._mapTriangleCount,
        state._mapFaceToSideBuffer,
        params,
        true
    );
}

function buildMapProjectionPreviewMesh(params = getMapProjectionParams()) {
    clearMapProjectionPreview();
    if (!state._mapTriangleXyz || !state._mapTriangleColors || !state._mapTriangleCount) return false;

    const sourceCount = state._mapTriangleCount;
    const step = Math.max(1, Math.ceil(sourceCount / MAP_PROJECTION_PREVIEW_MAX_SIDES));
    const previewCount = Math.ceil(sourceCount / step);
    const sourceXyz = new Float32Array(previewCount * 9);
    const sourceColors = new Float32Array(previewCount * 9);
    let dst = 0;
    for (let s = 0; s < sourceCount; s += step) {
        const src = s * 9;
        sourceXyz.set(state._mapTriangleXyz.subarray(src, src + 9), dst);
        sourceColors.set(state._mapTriangleColors.subarray(src, src + 9), dst);
        dst += 9;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(previewCount * 2 * 9), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(previewCount * 2 * 9), 3));
    setStableMapBounds(geo);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, clippingPlanes: MAP_CLIP_PLANES });
    state.mapProjectionPreviewMesh = new THREE.Mesh(geo, mat);
    state.mapProjectionPreviewMesh.visible = false;
    state._mapPreviewTriangleXyz = sourceXyz;
    state._mapPreviewTriangleColors = sourceColors;
    state._mapPreviewTriangleCount = previewCount;
    state._mapPreviewFaceToSideBuffer = new Int32Array(previewCount * 2);
    updateProjectedTriangleMesh(state.mapProjectionPreviewMesh, sourceXyz, sourceColors, previewCount, state._mapPreviewFaceToSideBuffer, params, false);
    scene.add(state.mapProjectionPreviewMesh);
    return true;
}

function updateMapProjectionPreviewMesh(params = getMapProjectionParams()) {
    if (!state.mapProjectionPreviewMesh && !buildMapProjectionPreviewMesh(params)) return false;
    return updateProjectedTriangleMesh(
        state.mapProjectionPreviewMesh,
        state._mapPreviewTriangleXyz,
        state._mapPreviewTriangleColors,
        state._mapPreviewTriangleCount,
        state._mapPreviewFaceToSideBuffer,
        params,
        false
    );
}

export function setMapProjectionPreviewActive(active, params = getMapProjectionParams()) {
    if (active) {
        const ok = updateMapProjectionPreviewMesh(params);
        if (!ok) return false;
        if (state.mapMesh) state.mapMesh.visible = false;
        if (state.mapProjectionPreviewMesh) state.mapProjectionPreviewMesh.visible = !!state.mapMode;
        return true;
    }
    if (state.mapProjectionPreviewMesh) state.mapProjectionPreviewMesh.visible = false;
    if (state.mapMesh) state.mapMesh.visible = !!state.mapMode;
    return true;
}

function updateProjectedXyzLineMesh(lineMesh, sourceSegments, sourceCount, z, params) {
    if (!lineMesh || !sourceSegments || !sourceCount) return false;
    const geo = lineMesh.geometry;
    const posAttr = geo.getAttribute('position');
    if (!posAttr) return false;
    const positions = posAttr.array;
    const maxSegments = Math.floor(positions.length / 6);
    const projector = createMapProjectionProjector(params);
    let segCount = 0;

    for (let i = 0; i < sourceCount; i++) {
        const src = i * 6;
        if (segCount + 2 > maxSegments) break;
        segCount += writeProjectedMapSegmentFromXyz(projector, sourceSegments, src, positions, segCount * 6, z);
    }

    geo.setDrawRange(0, segCount * 2);
    posAttr.needsUpdate = true;
    return true;
}

function updateProjectedLonLatLineMesh(lineMesh, sourceSegments, sourceCount, z, params) {
    if (!lineMesh || !sourceSegments || !sourceCount) return false;
    const geo = lineMesh.geometry;
    const posAttr = geo.getAttribute('position');
    if (!posAttr) return false;
    const positions = posAttr.array;
    const maxSegments = Math.floor(positions.length / 6);
    const projector = createMapProjectionProjector(params);
    let segCount = 0;

    for (let i = 0; i < sourceCount; i++) {
        const src = i * 4;
        if (segCount + 2 > maxSegments) break;
        segCount += writeProjectedMapSegmentFromLonLat(projector, sourceSegments, src, positions, segCount * 6, z);
    }

    geo.setDrawRange(0, segCount * 2);
    posAttr.needsUpdate = true;
    return true;
}

export function updateMapProjectionMeshes(params = getMapProjectionParams(), { previewOnly = false } = {}) {
    const meshUpdated = previewOnly ? updateMapProjectionPreviewMesh(params) : updateMapMeshProjection(params);
    updateProjectedLonLatLineMesh(state.mapGridMesh, state._mapGridSourceSegments, state._mapGridSourceCount, 0.001, params);
    updateProjectedXyzLineMesh(state.mapSuperPlateBorderMesh, state._mapBorderSourceSegments, state._mapBorderSourceCount, 0.002, params);
    return meshUpdated;
}

// Build projected map mesh.
export function buildMapMesh() {
    if (state.mapMesh) { scene.remove(state.mapMesh); state.mapMesh.geometry.dispose(); state.mapMesh.material.dispose(); state.mapMesh = null; }
    clearMapProjectionCache();
    if (!state.curData || !state.mapMode) return;

    const { mesh, r_xyz, t_xyz, r_plate, r_elevation, t_elevation, mountain_r, coastline_r, ocean_r, r_stress, debugLayers } = state.curData;
    const showPlates = document.getElementById('chkPlates').checked;
    const showStress = false;
    const waterLevel = 0;
    const debugLayer = state.debugLayer || '';

    let dbgArr = null, dbgMin = 0, dbgMax = 0;
    const isHeightmap = debugLayer === 'heightmap';
    const isLandHeightmap = debugLayer === 'landheightmap';
    const isOceanCurrent = debugLayer === 'oceanCurrentSummer' || debugLayer === 'oceanCurrentWinter';
    const oceanSeason = debugLayer === 'oceanCurrentWinter' ? 'winter' : 'summer';
    const oceanWarmth = isOceanCurrent ? state.curData[`r_ocean_warmth_${oceanSeason}`] : null;
    const oceanSpeed = isOceanCurrent ? state.curData[`r_ocean_speed_${oceanSeason}`] : null;
    if (isOceanCurrent && (!oceanWarmth || !oceanSpeed)) {
        console.warn(`[buildMapMesh] Ocean current layer "${debugLayer}" selected but data missing (warmth=${!!oceanWarmth}, speed=${!!oceanSpeed}). Hard-refresh (Ctrl+Shift+R) and generate a new planet.`);
    }
    const isPrecip = debugLayer === 'precipSummer' || debugLayer === 'precipWinter';
    const precipArr = isPrecip ? (debugLayers && debugLayers[debugLayer]) : null;
    const isRainShadow = debugLayer === 'rainShadowSummer' || debugLayer === 'rainShadowWinter';
    const rainShadowArr = isRainShadow ? (debugLayers && debugLayers[debugLayer]) : null;
    const isTemp = debugLayer === 'tempSummer' || debugLayer === 'tempWinter';
    const tempArr = isTemp ? (debugLayers && debugLayers[debugLayer]) : null;
    const isKoppen = debugLayer === 'koppen';
    const isBiome = debugLayer === 'biome';
    const koppenArr = (isKoppen || isBiome) ? (debugLayers && debugLayers.koppen) : null;
    const isCont = debugLayer === 'continentality';
    const contArr = isCont ? (debugLayers && debugLayers.continentality) : null;
    const isTempCont = debugLayer === 'tempContinentality';
    const tempContArr = isTempCont ? (debugLayers && debugLayers.tempContinentality) : null;
    if (!isHeightmap && !isLandHeightmap && !isOceanCurrent && !isPrecip && !isRainShadow && !isTemp && !isKoppen && !isBiome && !isCont && !isTempCont && debugLayer && debugLayers && debugLayers[debugLayer]) {
        dbgArr = debugLayers[debugLayer];
        for (let r = 0; r < mesh.numRegions; r++) {
            if (dbgArr[r] < dbgMin) dbgMin = dbgArr[r];
            if (dbgArr[r] > dbgMax) dbgMax = dbgArr[r];
        }
    }

    const { numSides } = mesh;
    const projectionParams = getMapProjectionParams();

    const biomeSmoothed = (isBiome && koppenArr) ? getCachedBiomeSmoothed(mesh, koppenArr, r_elevation) : null;
    const isSmooth = isHeightmap || isLandHeightmap;

    const maxTriCount = projectedTriangleCapacity(numSides);
    const posArr = new Float32Array(maxTriCount * 9);
    const colArr = new Float32Array(maxTriCount * 9);
    const sourceXyz = new Float32Array(numSides * 9);
    const sourceColors = new Float32Array(numSides * 9);
    const faceToSide = new Int32Array(maxTriCount);

    for (let s = 0; s < numSides; s++) {
        const it = mesh.s_inner_t(s);
        const ot = mesh.s_outer_t(s);
        const br = mesh.s_begin_r(s);

        const re = r_elevation[br] - waterLevel;

        // Per-vertex colors for smooth heightmaps, flat for everything else
        let c0r, c0g, c0b, c1r, c1g, c1b, c2r, c2g, c2b;
        if (isSmooth) {
            const colorFn = isLandHeightmap ? landHeightmapColor : heightmapColor;
            const v0 = colorFn(t_elevation[it])[0];
            const v1 = colorFn(t_elevation[ot])[0];
            const v2 = colorFn(r_elevation[br])[0];
            c0r = c0g = c0b = v0;
            c1r = c1g = c1b = v1;
            c2r = c2g = c2b = v2;
        } else {
            let cr, cg, cb;
            if (isBiome && biomeSmoothed) {
                cr = biomeSmoothed[br * 3]; cg = biomeSmoothed[br * 3 + 1]; cb = biomeSmoothed[br * 3 + 2];
            } else if (isCont && contArr) {
                [cr, cg, cb] = continentalityColor(contArr[br]);
            } else if (isTempCont && tempContArr) {
                [cr, cg, cb] = tempContinentalityColor(tempContArr[br]);
            } else if (isKoppen && koppenArr) {
                [cr, cg, cb] = koppenColor(koppenArr[br]);
            } else if (isTemp && tempArr) {
                [cr, cg, cb] = temperatureColor(tempArr[br]);
            } else if (isPrecip && precipArr) {
                [cr, cg, cb] = precipitationColor(precipArr[br]);
            } else if (isRainShadow && rainShadowArr) {
                [cr, cg, cb] = rainShadowColor(rainShadowArr[br]);
            } else if (isOceanCurrent && oceanWarmth && oceanSpeed) {
                [cr, cg, cb] = oceanCurrentColor(oceanWarmth[br], oceanSpeed[br], r_elevation[br] <= 0);
            } else if (isOceanCurrent) {
                cr = 0.5; cg = 0; cb = 0.5;
            } else if (dbgArr) {
                [cr, cg, cb] = debugValueToColor(dbgArr[br], dbgMin, dbgMax);
            } else if (showPlates) {
                const pc = state.plateColors[r_plate[br]] || new THREE.Color(0.3,0.3,0.3);
                cr = pc.r; cg = pc.g; cb = pc.b;
            } else if (showStress) {
                const sv = r_stress ? r_stress[br] : 0;
                if (sv > 0.5)                     { cr=0.9; cg=0.1+sv*0.3; cb=0.1; }
                else if (sv > 0.1)                { cr=0.9; cg=0.5+sv*0.5; cb=0.2; }
                else if (mountain_r.has(br))      { cr=0.8; cg=0.4; cb=0.1; }
                else if (coastline_r.has(br))     { cr=0.9; cg=0.9; cb=0.2; }
                else if (ocean_r.has(br))         { cr=0.1; cg=0.2; cb=0.7; }
                else                              { cr=0.15; cg=0.15; cb=0.18; }
            } else {
                [cr, cg, cb] = elevationToColor(re);
            }
            c0r = c1r = c2r = cr;
            c0g = c1g = c2g = cg;
            c0b = c1b = c2b = cb;
        }

        const x0 = t_xyz[3*it], y0 = t_xyz[3*it+1], z0 = t_xyz[3*it+2];
        const x1 = t_xyz[3*ot], y1 = t_xyz[3*ot+1], z1 = t_xyz[3*ot+2];
        const x2 = r_xyz[3*br], y2 = r_xyz[3*br+1], z2 = r_xyz[3*br+2];

        const off = s * 9;
        sourceXyz[off]     = x0; sourceXyz[off + 1] = y0; sourceXyz[off + 2] = z0;
        sourceXyz[off + 3] = x1; sourceXyz[off + 4] = y1; sourceXyz[off + 5] = z1;
        sourceXyz[off + 6] = x2; sourceXyz[off + 7] = y2; sourceXyz[off + 8] = z2;
        sourceColors[off]     = c0r; sourceColors[off + 1] = c0g; sourceColors[off + 2] = c0b;
        sourceColors[off + 3] = c1r; sourceColors[off + 4] = c1g; sourceColors[off + 5] = c1b;
        sourceColors[off + 6] = c2r; sourceColors[off + 7] = c2g; sourceColors[off + 8] = c2b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colArr, 3));
    setStableMapBounds(geo);

    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, clippingPlanes: MAP_CLIP_PLANES });
    state.mapMesh = new THREE.Mesh(geo, mat);
    state.mapMesh.visible = state.mapMode;
    state._mapTriangleXyz = sourceXyz;
    state._mapTriangleColors = sourceColors;
    state._mapTriangleCount = numSides;
    state._mapTriangleCapacity = maxTriCount;
    state._mapFaceToSideBuffer = faceToSide;
    updateMapMeshProjection(projectionParams);
    scene.add(state.mapMesh);
    buildMapProjectionPreviewMesh(projectionParams);

    updateSuperPlateBorders();
    buildMapGrid();
}

// Build lat/lon grid overlay for map view.
function buildMapGrid() {
    if (state.mapGridMesh) {
        scene.remove(state.mapGridMesh);
        state.mapGridMesh.geometry.dispose();
        state.mapGridMesh.material.dispose();
        state.mapGridMesh = null;
    }
    state._mapGridSourceSegments = null;
    state._mapGridSourceCount = 0;

    const spacing = state.gridSpacing;
    const DEG = Math.PI / 180;
    const latSamples = Math.max(36, Math.ceil(180 / Math.max(2.5, spacing)) * 2);
    const lonSamples = Math.max(72, Math.ceil(360 / Math.max(2.5, spacing)) * 2);
    const source = [];

    function pushSegment(lon0, lat0, lon1, lat1) {
        source.push(lon0, lat0, lon1, lat1);
    }

    for (let deg = -90; deg <= 90; deg += spacing) {
        const lat = deg * DEG;
        for (let i = 0; i < lonSamples; i++) {
            const lon0 = (-180 + i * 360 / lonSamples) * DEG;
            const lon1 = (-180 + (i + 1) * 360 / lonSamples) * DEG;
            pushSegment(lon0, lat, lon1, lat);
        }
    }

    for (let deg = -180; deg <= 180; deg += spacing) {
        const lon = deg * DEG;
        for (let i = 0; i < latSamples; i++) {
            const lat0 = (-90 + i * 180 / latSamples) * DEG;
            const lat1 = (-90 + (i + 1) * 180 / latSamples) * DEG;
            pushSegment(lon, lat0, lon, lat1);
        }
    }

    const sourceCount = source.length / 4;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(sourceCount * 2 * 2 * 3), 3));
    setStableMapBounds(geo);
    const gridMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, clippingPlanes: MAP_CLIP_PLANES });
    state.mapGridMesh = new THREE.LineSegments(geo, gridMat);
    state.mapGridMesh.visible = state.mapMode && state.gridEnabled;
    state._mapGridSourceSegments = new Float32Array(source);
    state._mapGridSourceCount = sourceCount;
    updateProjectedLonLatLineMesh(state.mapGridMesh, state._mapGridSourceSegments, state._mapGridSourceCount, 0.001, getMapProjectionParams());
    scene.add(state.mapGridMesh);
}

// Build lat/lon grid on the 3D globe.
function buildGlobeGrid() {
    if (state.globeGridMesh) {
        scene.remove(state.globeGridMesh);
        state.globeGridMesh.geometry.dispose();
        state.globeGridMesh.material.dispose();
        state.globeGridMesh = null;
    }

    const spacing = state.gridSpacing;
    const R = 1.002; // slightly above water sphere
    const SEG = 120;  // segments per circle
    const positions = [];

    // Latitude lines
    for (let deg = -90; deg <= 90; deg += spacing) {
        if (deg === -90 || deg === 90) continue; // poles are points, skip
        const lat = deg * Math.PI / 180;
        const cosLat = Math.cos(lat);
        const y = Math.sin(lat) * R;
        for (let i = 0; i < SEG; i++) {
            const lon0 = (i / SEG) * Math.PI * 2;
            const lon1 = ((i + 1) / SEG) * Math.PI * 2;
            positions.push(
                Math.sin(lon0) * cosLat * R, y, Math.cos(lon0) * cosLat * R,
                Math.sin(lon1) * cosLat * R, y, Math.cos(lon1) * cosLat * R
            );
        }
    }

    // Longitude lines (semicircles pole to pole)
    for (let deg = -180; deg < 180; deg += spacing) {
        const lon = deg * Math.PI / 180;
        const sinLon = Math.sin(lon);
        const cosLon = Math.cos(lon);
        for (let i = 0; i < SEG; i++) {
            const lat0 = -Math.PI / 2 + (i / SEG) * Math.PI;
            const lat1 = -Math.PI / 2 + ((i + 1) / SEG) * Math.PI;
            positions.push(
                sinLon * Math.cos(lat0) * R, Math.sin(lat0) * R, cosLon * Math.cos(lat0) * R,
                sinLon * Math.cos(lat1) * R, Math.sin(lat1) * R, cosLon * Math.cos(lat1) * R
            );
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const gridMat = new THREE.ShaderMaterial({
        uniforms: {
            color: { value: new THREE.Color(0xffffff) },
            opacity: { value: 0.12 }
        },
        vertexShader: `
            void main() {
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                gl_Position.z -= 0.002 * gl_Position.w; // depth bias: render on top of nearby surfaces
            }
        `,
        fragmentShader: `
            uniform vec3 color;
            uniform float opacity;
            void main() {
                gl_FragColor = vec4(color, opacity);
            }
        `,
        transparent: true,
        depthWrite: false
    });
    state.globeGridMesh = new THREE.LineSegments(geo, gridMat);
    state.globeGridMesh.visible = !state.mapMode && state.gridEnabled;
    scene.add(state.globeGridMesh);
}

// Rebuild both grids (call when spacing changes).
export function rebuildGrids() {
    buildMapGrid();
    buildGlobeGrid();
}

// Ocean current debug color: warmth × speed, with gray land.
function oceanCurrentColor(warmth, speed, isOcean) {
    if (!isOcean) return [0.45, 0.45, 0.45]; // gray land

    // speed is 0-1 (p95 normalized); ensure even low-speed areas are clearly visible
    const intensity = Math.pow(Math.min(1, speed * 3), 0.6); // gamma curve for more visible low values
    // Minimum brightness so all ocean is distinguishable from land and black background
    const base = 0.12;

    if (warmth > 0.05) {
        // Warm (poleward) → dark red-orange to bright red
        const w = Math.min(1, warmth * 1.5);
        const t = base + (1 - base) * w * intensity;
        return [t, base * 0.4 + t * 0.1, base * 0.3];
    } else if (warmth < -0.05) {
        // Cold (equatorward) → dark blue to bright blue
        const w = Math.min(1, -warmth * 1.5);
        const t = base + (1 - base) * w * intensity;
        return [base * 0.3, base * 0.5 + t * 0.15, t];
    } else {
        // Neutral (zonal) → dark teal-gray
        const t = base + intensity * 0.45;
        return [t * 0.55, t * 0.7, t * 0.65];
    }
}

// Build / destroy super plate boundary lines for both globe and map views.
// Called from buildMesh, buildMapMesh, and the Show Plates checkbox handler.
export function updateSuperPlateBorders() {
    // Cleanup existing
    if (state.superPlateBorderMesh) { scene.remove(state.superPlateBorderMesh); state.superPlateBorderMesh.geometry.dispose(); state.superPlateBorderMesh.material.dispose(); state.superPlateBorderMesh = null; }
    if (state.mapSuperPlateBorderMesh) { scene.remove(state.mapSuperPlateBorderMesh); state.mapSuperPlateBorderMesh.geometry.dispose(); state.mapSuperPlateBorderMesh.material.dispose(); state.mapSuperPlateBorderMesh = null; }
    state._mapBorderSourceSegments = null;
    state._mapBorderSourceCount = 0;

    if (!state.curData) return;
    const showPlates = document.getElementById('chkPlates').checked;
    if (!showPlates) return;

    const { mesh, t_xyz, t_elevation, debugLayers } = state.curData;
    if (!debugLayers || !debugLayers.superPlates) return;
    const spArr = debugLayers.superPlates;
    const { numSides } = mesh;
    const PI = Math.PI;
    const V = 0.04;

    // Globe borders
    if (!state.mapMode) {
        const bp = [];
        for (let s = 0; s < numSides; s++) {
            const opp = mesh.halfedges[s];
            if (s < opp) {
                const r1 = mesh.s_begin_r(s);
                const r2 = mesh.s_begin_r(opp);
                if (spArr[r1] !== spArr[r2]) {
                    const it = mesh.s_inner_t(s), ot = mesh.s_outer_t(s);
                    const ite = t_elevation[it], ote = t_elevation[ot];
                    const d1 = 1.002 + (ite > 0 ? ite*V : ite*V*0.3);
                    const d2 = 1.002 + (ote > 0 ? ote*V : ote*V*0.3);
                    bp.push(
                        t_xyz[3*it]*d1, t_xyz[3*it+1]*d1, t_xyz[3*it+2]*d1,
                        t_xyz[3*ot]*d2, t_xyz[3*ot+1]*d2, t_xyz[3*ot+2]*d2
                    );
                }
            }
        }
        if (bp.length > 0) {
            const bg = new THREE.BufferGeometry();
            bg.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
            state.superPlateBorderMesh = new THREE.LineSegments(bg,
                new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55 }));
            if (state.planetMesh) state.superPlateBorderMesh.rotation.copy(state.planetMesh.rotation);
            scene.add(state.superPlateBorderMesh);
        }
    }

    // Map borders
    if (state.mapMode) {
        const sourceSegments = [];
        for (let s = 0; s < numSides; s++) {
            const opp = mesh.halfedges[s];
            if (s < opp) {
                const r1 = mesh.s_begin_r(s);
                const r2 = mesh.s_begin_r(opp);
                if (spArr[r1] !== spArr[r2]) {
                    const it = mesh.s_inner_t(s), ot = mesh.s_outer_t(s);
                    sourceSegments.push(
                        t_xyz[3*it], t_xyz[3*it+1], t_xyz[3*it+2],
                        t_xyz[3*ot], t_xyz[3*ot+1], t_xyz[3*ot+2]
                    );
                }
            }
        }
        if (sourceSegments.length > 0) {
            const sourceCount = sourceSegments.length / 6;
            const bg = new THREE.BufferGeometry();
            bg.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(sourceCount * 2 * 2 * 3), 3));
            setStableMapBounds(bg);
            const bMat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, clippingPlanes: MAP_CLIP_PLANES });
            state.mapSuperPlateBorderMesh = new THREE.LineSegments(bg, bMat);
            state._mapBorderSourceSegments = new Float32Array(sourceSegments);
            state._mapBorderSourceCount = sourceCount;
            updateProjectedXyzLineMesh(state.mapSuperPlateBorderMesh, state._mapBorderSourceSegments, state._mapBorderSourceCount, 0.002, getMapProjectionParams());
            scene.add(state.mapSuperPlateBorderMesh);
        }
    }
}

// Build Voronoi mesh — each half-edge produces one triangle.
export function buildMesh() {
    if (!state.curData) return;
    const { mesh, r_xyz, t_xyz, r_plate, r_elevation, t_elevation, mountain_r, coastline_r, ocean_r, r_stress, debugLayers } = state.curData;
    const showPlates = document.getElementById('chkPlates').checked;
    const showStress = false;
    const waterLevel = 0;
    const debugLayer = state.debugLayer || '';

    // Precompute debug layer min/max if active
    let dbgArr = null, dbgMin = 0, dbgMax = 0;
    const isHeightmap = debugLayer === 'heightmap';
    const isLandHeightmap = debugLayer === 'landheightmap';
    const isOceanCurrent = debugLayer === 'oceanCurrentSummer' || debugLayer === 'oceanCurrentWinter';
    const oceanSeason = debugLayer === 'oceanCurrentWinter' ? 'winter' : 'summer';
    const oceanWarmth = isOceanCurrent ? state.curData[`r_ocean_warmth_${oceanSeason}`] : null;
    const oceanSpeed = isOceanCurrent ? state.curData[`r_ocean_speed_${oceanSeason}`] : null;
    if (isOceanCurrent && (!oceanWarmth || !oceanSpeed)) {
        console.warn(`[buildMesh] Ocean current layer "${debugLayer}" selected but data missing (warmth=${!!oceanWarmth}, speed=${!!oceanSpeed}). Hard-refresh (Ctrl+Shift+R) and generate a new planet.`);
    }
    const isPrecip = debugLayer === 'precipSummer' || debugLayer === 'precipWinter';
    const precipArr = isPrecip ? (debugLayers && debugLayers[debugLayer]) : null;
    const isRainShadow = debugLayer === 'rainShadowSummer' || debugLayer === 'rainShadowWinter';
    const rainShadowArr = isRainShadow ? (debugLayers && debugLayers[debugLayer]) : null;
    const isTemp = debugLayer === 'tempSummer' || debugLayer === 'tempWinter';
    const tempArr = isTemp ? (debugLayers && debugLayers[debugLayer]) : null;
    const isKoppen = debugLayer === 'koppen';
    const isBiome = debugLayer === 'biome';
    const koppenArr = (isKoppen || isBiome) ? (debugLayers && debugLayers.koppen) : null;
    const isCont = debugLayer === 'continentality';
    const contArr = isCont ? (debugLayers && debugLayers.continentality) : null;
    const isTempCont = debugLayer === 'tempContinentality';
    const tempContArr = isTempCont ? (debugLayers && debugLayers.tempContinentality) : null;
    if (!isHeightmap && !isLandHeightmap && !isOceanCurrent && !isPrecip && !isRainShadow && !isTemp && !isKoppen && !isBiome && !isCont && !isTempCont && debugLayer && debugLayers && debugLayers[debugLayer]) {
        dbgArr = debugLayers[debugLayer];
        for (let r = 0; r < mesh.numRegions; r++) {
            if (dbgArr[r] < dbgMin) dbgMin = dbgArr[r];
            if (dbgArr[r] > dbgMax) dbgMax = dbgArr[r];
        }
    }

    if (state.planetMesh) { scene.remove(state.planetMesh); state.planetMesh.geometry.dispose(); state.planetMesh.material.dispose(); }
    if (state.wireMesh)   { scene.remove(state.wireMesh);   state.wireMesh.geometry.dispose();   state.wireMesh.material.dispose(); }

    const { numSides } = mesh;
    const V = 0.04;
    const pos = new Float32Array(numSides * 9);
    const col = new Float32Array(numSides * 9);
    const isSmooth = isHeightmap || isLandHeightmap;
    // Track per-side winding swaps so updateMeshColors can assign per-vertex colors correctly
    const sideSwapped = new Uint8Array(numSides);

    const biomeSmoothed = (isBiome && koppenArr) ? getCachedBiomeSmoothed(mesh, koppenArr, r_elevation) : null;

    for (let s = 0; s < numSides; s++) {
        const it = mesh.s_inner_t(s);
        const ot = mesh.s_outer_t(s);
        const br = mesh.s_begin_r(s);

        const re  = r_elevation[br]  - waterLevel;
        const ite = t_elevation[it]  - waterLevel;
        const ote = t_elevation[ot]  - waterLevel;

        const rDisp  = 1.0 + (re  > 0 ? re  * V : re  * V * 0.3);
        const itDisp = 1.0 + (ite > 0 ? ite * V : ite * V * 0.3);
        const otDisp = 1.0 + (ote > 0 ? ote * V : ote * V * 0.3);

        const off = s * 9;
        let v0x = t_xyz[3*it]   * itDisp,
            v0y = t_xyz[3*it+1] * itDisp,
            v0z = t_xyz[3*it+2] * itDisp;
        let v1x = t_xyz[3*ot]   * otDisp,
            v1y = t_xyz[3*ot+1] * otDisp,
            v1z = t_xyz[3*ot+2] * otDisp;
        let v2x = r_xyz[3*br]   * rDisp,
            v2y = r_xyz[3*br+1] * rDisp,
            v2z = r_xyz[3*br+2] * rDisp;

        // Fix winding order
        const e1x = v1x-v0x, e1y = v1y-v0y, e1z = v1z-v0z;
        const e2x = v2x-v0x, e2y = v2y-v0y, e2z = v2z-v0z;
        const nx = e1y*e2z - e1z*e2y;
        const ny = e1z*e2x - e1x*e2z;
        const nz = e1x*e2y - e1y*e2x;
        const cnx = (v0x+v1x+v2x)/3, cny = (v0y+v1y+v2y)/3, cnz = (v0z+v1z+v2z)/3;
        const swapped = nx*cnx + ny*cny + nz*cnz < 0;
        if (swapped) {
            let tx, ty, tz;
            tx=v1x; ty=v1y; tz=v1z;
            v1x=v2x; v1y=v2y; v1z=v2z;
            v2x=tx; v2y=ty; v2z=tz;
        }
        sideSwapped[s] = swapped ? 1 : 0;

        pos[off]   = v0x; pos[off+1] = v0y; pos[off+2] = v0z;
        pos[off+3] = v1x; pos[off+4] = v1y; pos[off+5] = v1z;
        pos[off+6] = v2x; pos[off+7] = v2y; pos[off+8] = v2z;

        if (isSmooth) {
            // Smooth heightmap: per-vertex colors from averaged triangle elevations
            const colorFn = isLandHeightmap ? landHeightmapColor : heightmapColor;
            const c0 = colorFn(t_elevation[it])[0];  // inner_t (vertex 0, never swapped)
            const cOt = colorFn(t_elevation[ot])[0];  // outer_t
            const cBr = colorFn(r_elevation[br])[0];  // begin_r
            // After winding fix, v1/v2 may have swapped (outer_t ↔ begin_r)
            const c1 = swapped ? cBr : cOt;
            const c2 = swapped ? cOt : cBr;
            col[off] = col[off+1] = col[off+2] = c0;
            col[off+3] = col[off+4] = col[off+5] = c1;
            col[off+6] = col[off+7] = col[off+8] = c2;
        } else {
            let cr, cg, cb;
            if (isBiome && biomeSmoothed) {
                cr = biomeSmoothed[br * 3]; cg = biomeSmoothed[br * 3 + 1]; cb = biomeSmoothed[br * 3 + 2];
            } else if (isCont && contArr) {
                [cr, cg, cb] = continentalityColor(contArr[br]);
            } else if (isTempCont && tempContArr) {
                [cr, cg, cb] = tempContinentalityColor(tempContArr[br]);
            } else if (isKoppen && koppenArr) {
                [cr, cg, cb] = koppenColor(koppenArr[br]);
            } else if (isTemp && tempArr) {
                [cr, cg, cb] = temperatureColor(tempArr[br]);
            } else if (isPrecip && precipArr) {
                [cr, cg, cb] = precipitationColor(precipArr[br]);
            } else if (isRainShadow && rainShadowArr) {
                [cr, cg, cb] = rainShadowColor(rainShadowArr[br]);
            } else if (isOceanCurrent && oceanWarmth && oceanSpeed) {
                [cr, cg, cb] = oceanCurrentColor(oceanWarmth[br], oceanSpeed[br], r_elevation[br] <= 0);
            } else if (isOceanCurrent) {
                cr = 0.5; cg = 0; cb = 0.5;
            } else if (isLandHeightmap) {
                [cr, cg, cb] = landHeightmapColor(r_elevation[br]);
            } else if (isHeightmap) {
                [cr, cg, cb] = heightmapColor(r_elevation[br]);
            } else if (dbgArr) {
                [cr, cg, cb] = debugValueToColor(dbgArr[br], dbgMin, dbgMax);
            } else if (showPlates) {
                const pc = state.plateColors[r_plate[br]] || new THREE.Color(0.3,0.3,0.3);
                cr = pc.r; cg = pc.g; cb = pc.b;
            } else if (showStress) {
                const sv = r_stress ? r_stress[br] : 0;
                if (sv > 0.5)                     { cr=0.9; cg=0.1+sv*0.3; cb=0.1; }
                else if (sv > 0.1)                { cr=0.9; cg=0.5+sv*0.5; cb=0.2; }
                else if (mountain_r.has(br))      { cr=0.8; cg=0.4; cb=0.1; }
                else if (coastline_r.has(br))     { cr=0.9; cg=0.9; cb=0.2; }
                else if (ocean_r.has(br))         { cr=0.1; cg=0.2; cb=0.7; }
                else                              { cr=0.15; cg=0.15; cb=0.18; }
            } else {
                [cr, cg, cb] = elevationToColor(re);
            }
            for (let j = 0; j < 3; j++) {
                col[off+j*3]   = cr;
                col[off+j*3+1] = cg;
                col[off+j*3+2] = cb;
            }
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));

    state._hoverBackup = null;
    state._koppenHoverBackup = null;
    state._sideSwapped = sideSwapped;

    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    mat.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader.replace(
            '#include <beginnormal_vertex>',
            'vec3 objectNormal = normalize(position);'
        );
    };
    state.planetMesh = new THREE.Mesh(geo, mat);
    scene.add(state.planetMesh);

    waterMesh.visible = !state.mapMode && !showPlates && !showStress && !debugLayer;

    // Voronoi-edge wireframe
    if (document.getElementById('chkWire').checked) {
        const lp = [];
        for (let s = 0; s < numSides; s++) {
            if (s < mesh.halfedges[s]) {
                const it = mesh.s_inner_t(s), ot = mesh.s_outer_t(s);
                const ite = t_elevation[it], ote = t_elevation[ot];
                const d1 = 1.001 + (ite > 0 ? ite*V : ite*V*0.3);
                const d2 = 1.001 + (ote > 0 ? ote*V : ote*V*0.3);
                lp.push(
                    t_xyz[3*it]*d1, t_xyz[3*it+1]*d1, t_xyz[3*it+2]*d1,
                    t_xyz[3*ot]*d2, t_xyz[3*ot+1]*d2, t_xyz[3*ot+2]*d2
                );
            }
        }
        const lg = new THREE.BufferGeometry();
        lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
        state.wireMesh = new THREE.LineSegments(lg,
            new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.12 }));
        scene.add(state.wireMesh);
    }

    updateSuperPlateBorders();

    buildDriftArrows();
    updatePendingHighlight();
    updateHoverHighlight();

    // Defer map mesh construction to reduce peak GPU memory — built on demand
    // when switching to map view (see viewMode handler in main.js).
    if (state.mapMode) buildMapMesh();
    buildGlobeGrid();
    if (state.mapMode) {
        state.planetMesh.visible = false;
        waterMesh.visible = false;
        atmosMesh.visible = false;
        starsMesh.visible = false;
        if (state.wireMesh) state.wireMesh.visible = false;
        if (state.arrowGroup) state.arrowGroup.visible = false;
        if (state.mapGridMesh) state.mapGridMesh.visible = state.gridEnabled;
        if (state.globeGridMesh) state.globeGridMesh.visible = false;
        if (state.oceanCurrentArrowGroup) {
            state.oceanCurrentArrowGroup.traverse(c => {
                if (c.name === 'oceanGlobe') c.visible = false;
                if (c.name === 'oceanMap') c.visible = true;
            });
        }
    } else {
        state.planetMesh.visible = true;
        atmosMesh.visible = true;
        starsMesh.visible = true;
        if (state.wireMesh) state.wireMesh.visible = true;
        if (state.arrowGroup) state.arrowGroup.visible = true;
        if (state.mapGridMesh) state.mapGridMesh.visible = false;
        if (state.globeGridMesh) state.globeGridMesh.visible = state.gridEnabled;
        if (state.oceanCurrentArrowGroup) {
            state.oceanCurrentArrowGroup.traverse(c => {
                if (c.name === 'oceanGlobe') c.visible = true;
                if (c.name === 'oceanMap') c.visible = false;
            });
        }
    }
}

// Update only color buffers for globe + map meshes (no geometry rebuild).
// Use this when switching display modes to avoid GPU memory spikes.
export function updateMeshColors() {
    if (!state.curData || !state.planetMesh) return;
    const { mesh, r_plate, r_elevation, t_elevation, mountain_r, coastline_r, ocean_r, r_stress, debugLayers } = state.curData;
    const showPlates = document.getElementById('chkPlates').checked;
    const showStress = false;
    const waterLevel = 0;
    const debugLayer = state.debugLayer || '';

    // Precompute debug layer state
    let dbgArr = null, dbgMin = 0, dbgMax = 0;
    const isHeightmap = debugLayer === 'heightmap';
    const isLandHeightmap = debugLayer === 'landheightmap';
    const isOceanCurrent = debugLayer === 'oceanCurrentSummer' || debugLayer === 'oceanCurrentWinter';
    const oceanSeason = debugLayer === 'oceanCurrentWinter' ? 'winter' : 'summer';
    const oceanWarmth = isOceanCurrent ? state.curData[`r_ocean_warmth_${oceanSeason}`] : null;
    const oceanSpeed = isOceanCurrent ? state.curData[`r_ocean_speed_${oceanSeason}`] : null;
    const isPrecip = debugLayer === 'precipSummer' || debugLayer === 'precipWinter';
    const precipArr = isPrecip ? (debugLayers && debugLayers[debugLayer]) : null;
    const isRainShadow = debugLayer === 'rainShadowSummer' || debugLayer === 'rainShadowWinter';
    const rainShadowArr = isRainShadow ? (debugLayers && debugLayers[debugLayer]) : null;
    const isTemp = debugLayer === 'tempSummer' || debugLayer === 'tempWinter';
    const tempArr = isTemp ? (debugLayers && debugLayers[debugLayer]) : null;
    const isKoppen = debugLayer === 'koppen';
    const isBiome = debugLayer === 'biome';
    const koppenArr = (isKoppen || isBiome) ? (debugLayers && debugLayers.koppen) : null;
    const isCont = debugLayer === 'continentality';
    const contArr = isCont ? (debugLayers && debugLayers.continentality) : null;
    const isTempCont = debugLayer === 'tempContinentality';
    const tempContArr = isTempCont ? (debugLayers && debugLayers.tempContinentality) : null;
    if (!isHeightmap && !isLandHeightmap && !isOceanCurrent && !isPrecip && !isRainShadow && !isTemp && !isKoppen && !isBiome && !isCont && !isTempCont && debugLayer && debugLayers && debugLayers[debugLayer]) {
        dbgArr = debugLayers[debugLayer];
        for (let r = 0; r < mesh.numRegions; r++) {
            if (dbgArr[r] < dbgMin) dbgMin = dbgArr[r];
            if (dbgArr[r] > dbgMax) dbgMax = dbgArr[r];
        }
    }

    // Precompute smoothed biome colors (one-pass neighbor blend)
    const biomeSmoothed = (isBiome && koppenArr) ? getCachedBiomeSmoothed(mesh, koppenArr, r_elevation) : null;

    // Color helper — returns [r,g,b] for a given region
    const getRegionColor = (br) => {
        if (isBiome && biomeSmoothed) return [biomeSmoothed[br * 3], biomeSmoothed[br * 3 + 1], biomeSmoothed[br * 3 + 2]];
        if (isCont && contArr) return continentalityColor(contArr[br]);
        if (isTempCont && tempContArr) return tempContinentalityColor(tempContArr[br]);
        if (isKoppen && koppenArr) return koppenColor(koppenArr[br]);
        if (isTemp && tempArr) return temperatureColor(tempArr[br]);
        if (isPrecip && precipArr) return precipitationColor(precipArr[br]);
        if (isRainShadow && rainShadowArr) return rainShadowColor(rainShadowArr[br]);
        if (isOceanCurrent && oceanWarmth && oceanSpeed) return oceanCurrentColor(oceanWarmth[br], oceanSpeed[br], r_elevation[br] <= 0);
        if (isOceanCurrent) return [0.5, 0, 0.5];
        if (isLandHeightmap) return landHeightmapColor(r_elevation[br]);
        if (isHeightmap) return heightmapColor(r_elevation[br]);
        if (dbgArr) return debugValueToColor(dbgArr[br], dbgMin, dbgMax);
        if (showPlates) {
            const pc = state.plateColors[r_plate[br]] || new THREE.Color(0.3,0.3,0.3);
            return [pc.r, pc.g, pc.b];
        }
        if (showStress) {
            const sv = r_stress ? r_stress[br] : 0;
            if (sv > 0.5)                     return [0.9, 0.1+sv*0.3, 0.1];
            if (sv > 0.1)                     return [0.9, 0.5+sv*0.5, 0.2];
            if (mountain_r.has(br))           return [0.8, 0.4, 0.1];
            if (coastline_r.has(br))          return [0.9, 0.9, 0.2];
            if (ocean_r.has(br))              return [0.1, 0.2, 0.7];
            return [0.15, 0.15, 0.18];
        }
        return elevationToColor(r_elevation[br] - waterLevel);
    };

    // Update globe mesh colors in-place
    const colorAttr = state.planetMesh.geometry.getAttribute('color');
    const colors = colorAttr.array;
    const { numSides } = mesh;
    const isSmooth = isHeightmap || isLandHeightmap;
    const sideSwapped = state._sideSwapped;

    for (let s = 0; s < numSides; s++) {
        const off = s * 9;
        if (isSmooth) {
            const it = mesh.s_inner_t(s);
            const ot = mesh.s_outer_t(s);
            const br = mesh.s_begin_r(s);
            const colorFn = isLandHeightmap ? landHeightmapColor : heightmapColor;
            const c0 = colorFn(t_elevation[it])[0];
            const cOt = colorFn(t_elevation[ot])[0];
            const cBr = colorFn(r_elevation[br])[0];
            const swapped = sideSwapped && sideSwapped[s];
            const c1 = swapped ? cBr : cOt;
            const c2 = swapped ? cOt : cBr;
            colors[off] = colors[off+1] = colors[off+2] = c0;
            colors[off+3] = colors[off+4] = colors[off+5] = c1;
            colors[off+6] = colors[off+7] = colors[off+8] = c2;
        } else {
            const br = mesh.s_begin_r(s);
            const [cr, cg, cb] = getRegionColor(br);
            for (let j = 0; j < 3; j++) {
                colors[off + j*3]     = cr;
                colors[off + j*3 + 1] = cg;
                colors[off + j*3 + 2] = cb;
            }
        }
    }
    colorAttr.needsUpdate = true;
    state._hoverBackup = null;
    state._koppenHoverBackup = null;
    state._pendingBackup = null;

    if (state._mapTriangleColors) {
        const sourceMapColors = state._mapTriangleColors;
        for (let s = 0; s < numSides; s++) {
            const off = s * 9;
            if (isSmooth) {
                const it = mesh.s_inner_t(s);
                const ot = mesh.s_outer_t(s);
                const br = mesh.s_begin_r(s);
                const colorFn = isLandHeightmap ? landHeightmapColor : heightmapColor;
                const v0 = colorFn(t_elevation[it])[0];
                const v1 = colorFn(t_elevation[ot])[0];
                const v2 = colorFn(r_elevation[br])[0];
                sourceMapColors[off] = sourceMapColors[off+1] = sourceMapColors[off+2] = v0;
                sourceMapColors[off+3] = sourceMapColors[off+4] = sourceMapColors[off+5] = v1;
                sourceMapColors[off+6] = sourceMapColors[off+7] = sourceMapColors[off+8] = v2;
            } else {
                const br = mesh.s_begin_r(s);
                const [cr, cg, cb] = getRegionColor(br);
                for (let j = 0; j < 3; j++) {
                    sourceMapColors[off + j*3]     = cr;
                    sourceMapColors[off + j*3 + 1] = cg;
                    sourceMapColors[off + j*3 + 2] = cb;
                }
            }
        }
        clearMapProjectionPreview();
    }

    // Update map mesh colors in-place (if map exists)
    if (state.mapMesh && state.mapFaceToSide) {
        const mapColorAttr = state.mapMesh.geometry.getAttribute('color');
        const mapColors = mapColorAttr.array;
        const fts = state.mapFaceToSide;
        const sourceMapColors = state._mapTriangleColors;

        for (let f = 0; f < fts.length; f++) {
            const s = fts[f];
            const off = f * 9;
            if (sourceMapColors) {
                const src = s * 9;
                for (let j = 0; j < 9; j++) mapColors[off + j] = sourceMapColors[src + j];
            } else if (isSmooth) {
                const it = mesh.s_inner_t(s);
                const ot = mesh.s_outer_t(s);
                const br = mesh.s_begin_r(s);
                const colorFn = isLandHeightmap ? landHeightmapColor : heightmapColor;
                const v0 = colorFn(t_elevation[it])[0];
                const v1 = colorFn(t_elevation[ot])[0];
                const v2 = colorFn(r_elevation[br])[0];
                mapColors[off] = mapColors[off+1] = mapColors[off+2] = v0;
                mapColors[off+3] = mapColors[off+4] = mapColors[off+5] = v1;
                mapColors[off+6] = mapColors[off+7] = mapColors[off+8] = v2;
            } else {
                const br = mesh.s_begin_r(s);
                const [cr, cg, cb] = getRegionColor(br);
                for (let j = 0; j < 3; j++) {
                    mapColors[off + j*3]     = cr;
                    mapColors[off + j*3 + 1] = cg;
                    mapColors[off + j*3 + 2] = cb;
                }
            }
        }
        mapColorAttr.needsUpdate = true;
        state._mapHoverBackup = null;
        state._mapKoppenHoverBackup = null;
        state._mapPendingBackup = null;
    }

    // Update water visibility
    waterMesh.visible = !state.mapMode && !showPlates && !showStress && !debugLayer;

    updatePendingHighlight();
    updateMapPendingHighlight();
    updateHoverHighlight();
    updateMapHoverHighlight();
}

// Hover highlight — brighten hovered plate's cells (surgical save/restore).
export function updateHoverHighlight() {
    if (!state.planetMesh || !state.curData) return;
    const colorAttr = state.planetMesh.geometry.getAttribute('color');
    const colors = colorAttr.array;

    // Restore previously highlighted cells
    if (state._hoverBackup) {
        const { offsets, saved } = state._hoverBackup;
        for (let i = 0; i < offsets.length; i++) {
            const off = offsets[i] * 9;
            for (let j = 0; j < 9; j++) colors[off + j] = saved[i * 9 + j];
        }
        state._hoverBackup = null;
    }

    // Apply new highlight
    if (state.hoveredPlate >= 0) {
        const { mesh, r_plate } = state.curData;
        // Count cells for this plate
        let count = 0;
        for (let s = 0; s < mesh.numSides; s++) {
            if (r_plate[mesh.s_begin_r(s)] === state.hoveredPlate) count++;
        }
        const offsets = new Int32Array(count);
        const saved = new Float32Array(count * 9);
        let idx = 0;
        for (let s = 0; s < mesh.numSides; s++) {
            if (r_plate[mesh.s_begin_r(s)] === state.hoveredPlate) {
                offsets[idx] = s;
                const off = s * 9;
                for (let j = 0; j < 9; j++) saved[idx * 9 + j] = colors[off + j];
                for (let j = 0; j < 3; j++) {
                    colors[off + j*3]     = Math.min(1, colors[off + j*3]     + 0.22);
                    colors[off + j*3 + 1] = Math.min(1, colors[off + j*3 + 1] + 0.22);
                    colors[off + j*3 + 2] = Math.min(1, colors[off + j*3 + 2] + 0.22);
                }
                idx++;
            }
        }
        state._hoverBackup = { offsets, saved };
    }
    colorAttr.needsUpdate = true;
}

// Hover highlight for map mesh (surgical save/restore).
export function updateMapHoverHighlight() {
    if (!state.mapMesh || !state.curData || !state.mapFaceToSide) return;
    const colorAttr = state.mapMesh.geometry.getAttribute('color');
    const colors = colorAttr.array;

    // Restore previously highlighted cells
    if (state._mapHoverBackup) {
        const { offsets, saved } = state._mapHoverBackup;
        for (let i = 0; i < offsets.length; i++) {
            const off = offsets[i] * 9;
            for (let j = 0; j < 9; j++) colors[off + j] = saved[i * 9 + j];
        }
        state._mapHoverBackup = null;
    }

    // Apply new highlight
    if (state.hoveredPlate >= 0) {
        const { mesh, r_plate } = state.curData;
        const fts = state.mapFaceToSide;
        // Count faces for this plate
        let count = 0;
        for (let f = 0; f < fts.length; f++) {
            if (r_plate[mesh.s_begin_r(fts[f])] === state.hoveredPlate) count++;
        }
        const offsets = new Int32Array(count);
        const saved = new Float32Array(count * 9);
        let idx = 0;
        for (let f = 0; f < fts.length; f++) {
            if (r_plate[mesh.s_begin_r(fts[f])] === state.hoveredPlate) {
                offsets[idx] = f;
                const off = f * 9;
                for (let j = 0; j < 9; j++) saved[idx * 9 + j] = colors[off + j];
                for (let j = 0; j < 3; j++) {
                    colors[off + j*3]     = Math.min(1, colors[off + j*3]     + 0.22);
                    colors[off + j*3 + 1] = Math.min(1, colors[off + j*3 + 1] + 0.22);
                    colors[off + j*3 + 2] = Math.min(1, colors[off + j*3 + 2] + 0.22);
                }
                idx++;
            }
        }
        state._mapHoverBackup = { offsets, saved };
    }
    colorAttr.needsUpdate = true;
}

// Köppen legend hover highlight — brighten cells matching hovered climate class (globe).
export function updateKoppenHoverHighlight() {
    if (!state.planetMesh || !state.curData) return;
    const colorAttr = state.planetMesh.geometry.getAttribute('color');
    const colors = colorAttr.array;

    // Restore previously highlighted cells
    if (state._koppenHoverBackup) {
        const { offsets, saved } = state._koppenHoverBackup;
        for (let i = 0; i < offsets.length; i++) {
            const off = offsets[i] * 9;
            for (let j = 0; j < 9; j++) colors[off + j] = saved[i * 9 + j];
        }
        state._koppenHoverBackup = null;
    }

    if (state.hoveredKoppen >= 0) {
        const { mesh, debugLayers } = state.curData;
        const koppenArr = debugLayers && debugLayers.koppen;
        if (!koppenArr) { colorAttr.needsUpdate = true; return; }
        let count = 0;
        for (let s = 0; s < mesh.numSides; s++) {
            if (koppenArr[mesh.s_begin_r(s)] === state.hoveredKoppen) count++;
        }
        const offsets = new Int32Array(count);
        const saved = new Float32Array(count * 9);
        let idx = 0;
        for (let s = 0; s < mesh.numSides; s++) {
            if (koppenArr[mesh.s_begin_r(s)] === state.hoveredKoppen) {
                offsets[idx] = s;
                const off = s * 9;
                for (let j = 0; j < 9; j++) saved[idx * 9 + j] = colors[off + j];
                for (let j = 0; j < 3; j++) {
                    colors[off + j*3]     = Math.min(1, colors[off + j*3]     + 0.22);
                    colors[off + j*3 + 1] = Math.min(1, colors[off + j*3 + 1] + 0.22);
                    colors[off + j*3 + 2] = Math.min(1, colors[off + j*3 + 2] + 0.22);
                }
                idx++;
            }
        }
        state._koppenHoverBackup = { offsets, saved };
    }
    colorAttr.needsUpdate = true;
}

// Köppen legend hover highlight for map mesh (surgical save/restore).
export function updateMapKoppenHoverHighlight() {
    if (!state.mapMesh || !state.curData || !state.mapFaceToSide) return;
    const colorAttr = state.mapMesh.geometry.getAttribute('color');
    const colors = colorAttr.array;

    // Restore previously highlighted cells
    if (state._mapKoppenHoverBackup) {
        const { offsets, saved } = state._mapKoppenHoverBackup;
        for (let i = 0; i < offsets.length; i++) {
            const off = offsets[i] * 9;
            for (let j = 0; j < 9; j++) colors[off + j] = saved[i * 9 + j];
        }
        state._mapKoppenHoverBackup = null;
    }

    if (state.hoveredKoppen >= 0) {
        const { mesh, debugLayers } = state.curData;
        const koppenArr = debugLayers && debugLayers.koppen;
        if (!koppenArr) { colorAttr.needsUpdate = true; return; }
        const fts = state.mapFaceToSide;
        let count = 0;
        for (let f = 0; f < fts.length; f++) {
            if (koppenArr[mesh.s_begin_r(fts[f])] === state.hoveredKoppen) count++;
        }
        const offsets = new Int32Array(count);
        const saved = new Float32Array(count * 9);
        let idx = 0;
        for (let f = 0; f < fts.length; f++) {
            if (koppenArr[mesh.s_begin_r(fts[f])] === state.hoveredKoppen) {
                offsets[idx] = f;
                const off = f * 9;
                for (let j = 0; j < 9; j++) saved[idx * 9 + j] = colors[off + j];
                for (let j = 0; j < 3; j++) {
                    colors[off + j*3]     = Math.min(1, colors[off + j*3]     + 0.22);
                    colors[off + j*3 + 1] = Math.min(1, colors[off + j*3 + 1] + 0.22);
                    colors[off + j*3 + 2] = Math.min(1, colors[off + j*3 + 2] + 0.22);
                }
                idx++;
            }
        }
        state._mapKoppenHoverBackup = { offsets, saved };
    }
    colorAttr.needsUpdate = true;
}

// Pending-toggle highlight — tint plates queued for rebuild (surgical save/restore).
// Runs BEFORE hover highlight so hover saves/restores the already-tinted colors.
export function updatePendingHighlight() {
    if (!state.planetMesh || !state.curData) return;
    const colorAttr = state.planetMesh.geometry.getAttribute('color');
    const colors = colorAttr.array;

    // Restore previously highlighted cells
    if (state._pendingBackup) {
        const { offsets, saved } = state._pendingBackup;
        for (let i = 0; i < offsets.length; i++) {
            const off = offsets[i] * 9;
            for (let j = 0; j < 9; j++) colors[off + j] = saved[i * 9 + j];
        }
        state._pendingBackup = null;
    }

    if (state.pendingToggles.size > 0) {
        const { mesh, r_plate, plateIsOcean } = state.curData;
        let count = 0;
        for (let s = 0; s < mesh.numSides; s++) {
            if (state.pendingToggles.has(r_plate[mesh.s_begin_r(s)])) count++;
        }
        const offsets = new Int32Array(count);
        const saved = new Float32Array(count * 9);
        let idx = 0;
        for (let s = 0; s < mesh.numSides; s++) {
            const pid = r_plate[mesh.s_begin_r(s)];
            if (state.pendingToggles.has(pid)) {
                offsets[idx] = s;
                const off = s * 9;
                for (let j = 0; j < 9; j++) saved[idx * 9 + j] = colors[off + j];
                const isOcean = plateIsOcean.has(pid);
                for (let j = 0; j < 3; j++) {
                    if (isOcean) {
                        // Ocean → Land pending: strong green tint
                        colors[off + j*3]     = colors[off + j*3]     * 0.7;
                        colors[off + j*3 + 1] = Math.min(1, colors[off + j*3 + 1] + 0.25);
                        colors[off + j*3 + 2] = colors[off + j*3 + 2] * 0.7;
                    } else {
                        // Land → Ocean pending: strong blue tint
                        colors[off + j*3]     = colors[off + j*3]     * 0.7;
                        colors[off + j*3 + 1] = colors[off + j*3 + 1] * 0.7;
                        colors[off + j*3 + 2] = Math.min(1, colors[off + j*3 + 2] + 0.25);
                    }
                }
                idx++;
            }
        }
        state._pendingBackup = { offsets, saved };
    }
    colorAttr.needsUpdate = true;
}

// Pending-toggle highlight for map mesh (surgical save/restore).
export function updateMapPendingHighlight() {
    if (!state.mapMesh || !state.curData || !state.mapFaceToSide) return;
    const colorAttr = state.mapMesh.geometry.getAttribute('color');
    const colors = colorAttr.array;

    if (state._mapPendingBackup) {
        const { offsets, saved } = state._mapPendingBackup;
        for (let i = 0; i < offsets.length; i++) {
            const off = offsets[i] * 9;
            for (let j = 0; j < 9; j++) colors[off + j] = saved[i * 9 + j];
        }
        state._mapPendingBackup = null;
    }

    if (state.pendingToggles.size > 0) {
        const { mesh, r_plate, plateIsOcean } = state.curData;
        const fts = state.mapFaceToSide;
        let count = 0;
        for (let f = 0; f < fts.length; f++) {
            if (state.pendingToggles.has(r_plate[mesh.s_begin_r(fts[f])])) count++;
        }
        const offsets = new Int32Array(count);
        const saved = new Float32Array(count * 9);
        let idx = 0;
        for (let f = 0; f < fts.length; f++) {
            const pid = r_plate[mesh.s_begin_r(fts[f])];
            if (state.pendingToggles.has(pid)) {
                offsets[idx] = f;
                const off = f * 9;
                for (let j = 0; j < 9; j++) saved[idx * 9 + j] = colors[off + j];
                const isOcean = plateIsOcean.has(pid);
                for (let j = 0; j < 3; j++) {
                    if (isOcean) {
                        colors[off + j*3]     = colors[off + j*3]     * 0.7;
                        colors[off + j*3 + 1] = Math.min(1, colors[off + j*3 + 1] + 0.25);
                        colors[off + j*3 + 2] = colors[off + j*3 + 2] * 0.7;
                    } else {
                        colors[off + j*3]     = colors[off + j*3]     * 0.7;
                        colors[off + j*3 + 1] = colors[off + j*3 + 1] * 0.7;
                        colors[off + j*3 + 2] = Math.min(1, colors[off + j*3 + 2] + 0.25);
                    }
                }
                idx++;
            }
        }
        state._mapPendingBackup = { offsets, saved };
    }
    colorAttr.needsUpdate = true;
}

// Drift arrows — show plate movement directions.
export function buildDriftArrows() {
    if (state.arrowGroup) {
        state.arrowGroup.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
        scene.remove(state.arrowGroup);
        state.arrowGroup = null;
    }
    return;

    state.arrowGroup = new THREE.Group();
    const { r_xyz, plateSeeds, plateVec, plateIsOcean } = state.curData;

    for (const seed of plateSeeds) {
        const px = r_xyz[3*seed], py = r_xyz[3*seed+1], pz = r_xyz[3*seed+2];
        const pos = new THREE.Vector3(px, py, pz).normalize();
        const pv = plateVec[seed];
        const vel = [
            pv.omega * (pv.pole[1] * pz - pv.pole[2] * py),
            pv.omega * (pv.pole[2] * px - pv.pole[0] * pz),
            pv.omega * (pv.pole[0] * py - pv.pole[1] * px)
        ];
        const drift = new THREE.Vector3(...vel);

        const radial = drift.dot(pos);
        const tangent = drift.clone().sub(pos.clone().multiplyScalar(radial));
        if (tangent.length() < 0.001) continue;
        tangent.normalize();

        const origin = pos.clone().multiplyScalar(1.07);
        const length = 0.18;
        const color = plateIsOcean.has(seed) ? 0x66ccff : 0xffcc44;

        const arrow = new THREE.ArrowHelper(tangent, origin, length, color, 0.055, 0.03);
        state.arrowGroup.add(arrow);
    }

    scene.add(state.arrowGroup);
}

// Wind arrows — show wind direction/magnitude overlay.
export function buildWindArrows(season) {
    // Clean up previous arrows
    if (state.windArrowGroup) {
        state.windArrowGroup.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
        scene.remove(state.windArrowGroup);
        state.windArrowGroup = null;
    }

    if (!season || !state.curData || !state.curData.r_wind_east_summer) return;

    const { mesh, r_xyz,
        r_wind_east_summer, r_wind_north_summer,
        r_wind_east_winter, r_wind_north_winter } = state.curData;

    const windE = season === 'winter' ? r_wind_east_winter : r_wind_east_summer;
    const windN = season === 'winter' ? r_wind_north_winter : r_wind_north_summer;
    if (!windE || !windN) return;

    const PI = Math.PI;
    const DEG = PI / 180;
    const numRegions = mesh.numRegions;
    const projectionParams = getMapProjectionParams();

    // ── Bin regions into a lat/lon grid for even geographic sampling ──
    const LAT_STEP = 3; // degrees
    const LON_STEP = 3;
    const latBands = Math.floor(180 / LAT_STEP); // 60
    const lonBands = Math.floor(360 / LON_STEP); // 120

    // For each grid cell, find the closest region to the cell center
    const gridRegions = new Int32Array(latBands * lonBands).fill(-1);
    const gridDist2 = new Float32Array(latBands * lonBands).fill(1e9);

    for (let r = 0; r < numRegions; r++) {
        const ry = r_xyz[3 * r + 1];
        const lat = Math.asin(Math.max(-1, Math.min(1, ry)));
        const lon = Math.atan2(r_xyz[3 * r], r_xyz[3 * r + 2]);

        const li = Math.max(0, Math.min(latBands - 1,
            Math.floor((lat + PI / 2) / (LAT_STEP * DEG))));
        const lo = Math.max(0, Math.min(lonBands - 1,
            Math.floor((lon + PI) / (LON_STEP * DEG))));

        const cellLat = (-90 + li * LAT_STEP + LAT_STEP * 0.5) * DEG;
        const cellLon = (-180 + lo * LON_STEP + LON_STEP * 0.5) * DEG;
        const dlat = lat - cellLat, dlon = lon - cellLon;
        const d2 = dlat * dlat + dlon * dlon;

        const idx = li * lonBands + lo;
        if (d2 < gridDist2[idx]) {
            gridDist2[idx] = d2;
            gridRegions[idx] = r;
        }
    }

    const globePositions = [];
    const globeColors = [];
    const mapPositions = [];
    const mapColors = [];

    const HEAD_ANGLE = 25 * DEG;
    const HEAD_FRAC = 0.35; // arrowhead length as fraction of shaft
    const cosA = Math.cos(HEAD_ANGLE), sinA = Math.sin(HEAD_ANGLE);

    for (let i = 0; i < gridRegions.length; i++) {
        const r = gridRegions[i];
        if (r < 0) continue;

        const we = windE[r], wn = windN[r];
        const speed = Math.sqrt(we * we + wn * wn);
        if (speed < 0.001) continue;

        const x = r_xyz[3 * r], y = r_xyz[3 * r + 1], z = r_xyz[3 * r + 2];

        // Color: blue (slow) → yellow (medium) → red (fast)
        const t = Math.min(1, speed * 3);
        let cr, cg, cb;
        if (t < 0.5) {
            const s = t * 2;
            cr = s; cg = s; cb = 1 - s * 0.5;
        } else {
            const s = (t - 0.5) * 2;
            cr = 1; cg = 1 - s; cb = 0.5 - s * 0.5;
        }

        // ── Globe arrows: 3D with arrowhead ──
        {
            // Tangent frame (Y-up)
            let ex = z, ey = 0, ez = -x;
            const elen = Math.sqrt(ex * ex + ez * ez);
            if (elen > 1e-10) { ex /= elen; ez /= elen; }
            else { ex = 1; ez = 0; }

            let nx = y * ez - z * ey;
            let ny = z * ex - x * ez;
            let nz = x * ey - y * ex;
            const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            nx /= nlen; ny /= nlen; nz /= nlen;

            // Wind direction in 3D = we * east + wn * north
            const dirX = we * ex + wn * nx;
            const dirY = we * ey + wn * ny;
            const dirZ = we * ez + wn * nz;
            const dirLen = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;
            const dxn = dirX / dirLen, dyn = dirY / dirLen, dzn = dirZ / dirLen;

            // Perpendicular in tangent plane: position × dir
            let px = y * dzn - z * dyn;
            let py = z * dxn - x * dzn;
            let pz = x * dyn - y * dxn;
            const plen = Math.sqrt(px * px + py * py + pz * pz) || 1;
            px /= plen; py /= plen; pz /= plen;

            const arrowLen = 0.008 + Math.min(0.012, speed * 0.025);
            const R = 1.007;

            const ox = x * R, oy = y * R, oz = z * R;
            const tx = ox + dxn * arrowLen;
            const ty = oy + dyn * arrowLen;
            const tz = oz + dzn * arrowLen;

            // Shaft
            globePositions.push(ox, oy, oz, tx, ty, tz);
            globeColors.push(cr, cg, cb, cr, cg, cb);

            // Arrowhead wings
            const hLen = arrowLen * HEAD_FRAC;
            const lwx = tx + (-dxn * cosA + px * sinA) * hLen;
            const lwy = ty + (-dyn * cosA + py * sinA) * hLen;
            const lwz = tz + (-dzn * cosA + pz * sinA) * hLen;
            const rwx = tx + (-dxn * cosA - px * sinA) * hLen;
            const rwy = ty + (-dyn * cosA - py * sinA) * hLen;
            const rwz = tz + (-dzn * cosA - pz * sinA) * hLen;

            globePositions.push(tx, ty, tz, lwx, lwy, lwz);
            globeColors.push(cr, cg, cb, cr, cg, cb);
            globePositions.push(tx, ty, tz, rwx, rwy, rwz);
            globeColors.push(cr, cg, cb, cr, cg, cb);
        }

        // ── Map arrows: 2D with arrowhead ──
        {
            let ex = z, ey = 0, ez = -x;
            const elen = Math.sqrt(ex * ex + ez * ez);
            if (elen > 1e-10) { ex /= elen; ez /= elen; }
            else { ex = 1; ez = 0; }

            let nx = y * ez - z * ey;
            let ny = z * ex - x * ez;
            let nz = x * ey - y * ex;
            const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            nx /= nlen; ny /= nlen; nz /= nlen;

            const dirX = we * ex + wn * nx;
            const dirY = we * ey + wn * ny;
            const dirZ = we * ez + wn * nz;
            const dirLen = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;
            const mapDir = projectMapDirectionFromXyz(x, y, z, dirX / dirLen, dirY / dirLen, dirZ / dirLen, 0.035, projectionParams);
            if (!mapDir) continue;

            const arrowLen = 0.006 + Math.min(0.012, speed * 0.025);
            const mapLen = Math.sqrt(mapDir.dx * mapDir.dx + mapDir.dy * mapDir.dy) || 1;
            const dx = (mapDir.dx / mapLen) * arrowLen;
            const dy = (mapDir.dy / mapLen) * arrowLen;
            const mx = mapDir.x;
            const my = mapDir.y;
            const tipX = mx + dx, tipY = my + dy;

            // Shaft
            mapPositions.push(mx, my, 0.002, tipX, tipY, 0.002);
            mapColors.push(cr, cg, cb, cr, cg, cb);

            // Arrowhead wings (2D rotation of -dir)
            const hLen = arrowLen * HEAD_FRAC;
            const dLen = Math.sqrt(dx * dx + dy * dy) || 1;
            const ndx = -dx / dLen, ndy = -dy / dLen;

            const lx = tipX + (ndx * cosA - ndy * sinA) * hLen;
            const ly = tipY + (ndx * sinA + ndy * cosA) * hLen;
            const rx = tipX + (ndx * cosA + ndy * sinA) * hLen;
            const ry = tipY + (-ndx * sinA + ndy * cosA) * hLen;

            mapPositions.push(tipX, tipY, 0.002, lx, ly, 0.002);
            mapColors.push(cr, cg, cb, cr, cg, cb);
            mapPositions.push(tipX, tipY, 0.002, rx, ry, 0.002);
            mapColors.push(cr, cg, cb, cr, cg, cb);
        }
    }

    state.windArrowGroup = new THREE.Group();

    // Globe arrows
    if (globePositions.length > 0) {
        const gGeo = new THREE.BufferGeometry();
        gGeo.setAttribute('position', new THREE.Float32BufferAttribute(globePositions, 3));
        gGeo.setAttribute('color', new THREE.Float32BufferAttribute(globeColors, 3));
        const gMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false });
        const gLines = new THREE.LineSegments(gGeo, gMat);
        gLines.name = 'windGlobe';
        gLines.visible = !state.mapMode;
        state.windArrowGroup.add(gLines);
    }

    // Map arrows
    if (mapPositions.length > 0) {
        const mGeo = new THREE.BufferGeometry();
        mGeo.setAttribute('position', new THREE.Float32BufferAttribute(mapPositions, 3));
        mGeo.setAttribute('color', new THREE.Float32BufferAttribute(mapColors, 3));
        const mMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6 });
        const mLines = new THREE.LineSegments(mGeo, mMat);
        mLines.name = 'windMap';
        mLines.visible = state.mapMode;
        state.windArrowGroup.add(mLines);
    }

    // ── ITCZ spline line (shown on pressure layers) ──
    const isPressureLayer = season && (state.debugLayer === 'pressureSummer' || state.debugLayer === 'pressureWinter');
    const itczLons = state.curData.itczLons;
    const itczLats = season === 'winter' ? state.curData.itczLatsWinter : state.curData.itczLatsSummer;

    if (isPressureLayer && itczLons && itczLats) {
        const N = itczLons.length;
        const R_ITCZ = 1.01;

        // Globe: polyline on sphere surface
        const gPos = [];
        for (let i = 0; i < N; i++) {
            const j = (i + 1) % N;
            const lon0 = itczLons[i], lat0 = itczLats[i];
            const lon1 = itczLons[j], lat1 = itczLats[j];
            const cosLat0 = Math.cos(lat0), cosLat1 = Math.cos(lat1);
            gPos.push(
                Math.sin(lon0) * cosLat0 * R_ITCZ, Math.sin(lat0) * R_ITCZ, Math.cos(lon0) * cosLat0 * R_ITCZ,
                Math.sin(lon1) * cosLat1 * R_ITCZ, Math.sin(lat1) * R_ITCZ, Math.cos(lon1) * cosLat1 * R_ITCZ
            );
        }
        const igGeo = new THREE.BufferGeometry();
        igGeo.setAttribute('position', new THREE.Float32BufferAttribute(gPos, 3));
        const igMat = new THREE.LineBasicMaterial({ color: 0x00ff88, linewidth: 2, depthWrite: false });
        const igLines = new THREE.LineSegments(igGeo, igMat);
        igLines.name = 'windGlobe';
        igLines.visible = !state.mapMode;
        state.windArrowGroup.add(igLines);

        // Map: polyline on the active projection
        const mPos = [];
        for (let i = 0; i < N; i++) {
            const j = (i + 1) % N;
            const segments = projectMapSegmentFromLonLat(itczLons[i], itczLats[i], itczLons[j], itczLats[j], projectionParams);
            for (const [p0, p1] of segments) {
                mPos.push(p0.x, p0.y, 0.003, p1.x, p1.y, 0.003);
            }
        }
        const imGeo = new THREE.BufferGeometry();
        imGeo.setAttribute('position', new THREE.Float32BufferAttribute(mPos, 3));
        const imMat = new THREE.LineBasicMaterial({ color: 0x00ff88, linewidth: 2 });
        const imLines = new THREE.LineSegments(imGeo, imMat);
        imLines.name = 'windMap';
        imLines.visible = state.mapMode;
        state.windArrowGroup.add(imLines);
    }

    scene.add(state.windArrowGroup);
}

// Ocean current arrows — show current direction colored by heat transport.
export function buildOceanCurrentArrows(season) {
    // Clean up previous arrows
    if (state.oceanCurrentArrowGroup) {
        state.oceanCurrentArrowGroup.traverse(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
        scene.remove(state.oceanCurrentArrowGroup);
        state.oceanCurrentArrowGroup = null;
    }

    if (!season || !state.curData || !state.curData.r_ocean_current_east_summer) return;

    const { mesh, r_xyz, r_elevation } = state.curData;

    const currentE = season === 'winter'
        ? state.curData.r_ocean_current_east_winter : state.curData.r_ocean_current_east_summer;
    const currentN = season === 'winter'
        ? state.curData.r_ocean_current_north_winter : state.curData.r_ocean_current_north_summer;
    const speedArr = season === 'winter'
        ? state.curData.r_ocean_speed_winter : state.curData.r_ocean_speed_summer;
    const warmthArr = season === 'winter'
        ? state.curData.r_ocean_warmth_winter : state.curData.r_ocean_warmth_summer;
    if (!currentE || !currentN || !speedArr || !warmthArr) return;

    const PI = Math.PI;
    const DEG = PI / 180;
    const numRegions = mesh.numRegions;
    const projectionParams = getMapProjectionParams();

    // ── Bin regions into a lat/lon grid for even geographic sampling ──
    const LAT_STEP = 3;
    const LON_STEP = 3;
    const latBands = Math.floor(180 / LAT_STEP);
    const lonBands = Math.floor(360 / LON_STEP);

    const gridRegions = new Int32Array(latBands * lonBands).fill(-1);
    const gridDist2 = new Float32Array(latBands * lonBands).fill(1e9);

    for (let r = 0; r < numRegions; r++) {
        // Skip land
        if (r_elevation[r] > 0) continue;

        const ry = r_xyz[3 * r + 1];
        const lat = Math.asin(Math.max(-1, Math.min(1, ry)));
        const lon = Math.atan2(r_xyz[3 * r], r_xyz[3 * r + 2]);

        const li = Math.max(0, Math.min(latBands - 1,
            Math.floor((lat + PI / 2) / (LAT_STEP * DEG))));
        const lo = Math.max(0, Math.min(lonBands - 1,
            Math.floor((lon + PI) / (LON_STEP * DEG))));

        const cellLat = (-90 + li * LAT_STEP + LAT_STEP * 0.5) * DEG;
        const cellLon = (-180 + lo * LON_STEP + LON_STEP * 0.5) * DEG;
        const dlat = lat - cellLat, dlon = lon - cellLon;
        const d2 = dlat * dlat + dlon * dlon;

        const idx = li * lonBands + lo;
        if (d2 < gridDist2[idx]) {
            gridDist2[idx] = d2;
            gridRegions[idx] = r;
        }
    }

    const globePositions = [];
    const globeColors = [];
    const mapPositions = [];
    const mapColors = [];

    const HEAD_ANGLE = 25 * DEG;
    const HEAD_FRAC = 0.35;
    const cosA = Math.cos(HEAD_ANGLE), sinA = Math.sin(HEAD_ANGLE);

    for (let i = 0; i < gridRegions.length; i++) {
        const r = gridRegions[i];
        if (r < 0) continue;

        const ce = currentE[r], cn = currentN[r];
        const speed = speedArr[r];
        const warmth = warmthArr[r];
        if (speed < 0.01) continue;

        const x = r_xyz[3 * r], y = r_xyz[3 * r + 1], z = r_xyz[3 * r + 2];

        // Color by heat transport: red (warm/poleward), blue (cold/equatorward), gray (neutral)
        let cr, cg, cb;
        if (warmth > 0.1) {
            cr = 0.9; cg = 0.15; cb = 0.15;
        } else if (warmth < -0.1) {
            cr = 0.15; cg = 0.3; cb = 0.9;
        } else {
            cr = 0.5; cg = 0.5; cb = 0.5;
        }

        // ── Globe arrows: 3D with arrowhead ──
        {
            let ex = z, ey = 0, ez = -x;
            const elen = Math.sqrt(ex * ex + ez * ez);
            if (elen > 1e-10) { ex /= elen; ez /= elen; }
            else { ex = 1; ez = 0; }

            let nx = y * ez - z * ey;
            let ny = z * ex - x * ez;
            let nz = x * ey - y * ex;
            const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            nx /= nlen; ny /= nlen; nz /= nlen;

            const dirX = ce * ex + cn * nx;
            const dirY = ce * ey + cn * ny;
            const dirZ = ce * ez + cn * nz;
            const dirLen = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;
            const dxn = dirX / dirLen, dyn = dirY / dirLen, dzn = dirZ / dirLen;

            let px = y * dzn - z * dyn;
            let py = z * dxn - x * dzn;
            let pz = x * dyn - y * dxn;
            const plen = Math.sqrt(px * px + py * py + pz * pz) || 1;
            px /= plen; py /= plen; pz /= plen;

            const arrowLen = 0.006 + Math.min(0.014, speed * 0.025);
            const R = 1.007;

            const ox = x * R, oy = y * R, oz = z * R;
            const tx = ox + dxn * arrowLen;
            const ty = oy + dyn * arrowLen;
            const tz = oz + dzn * arrowLen;

            globePositions.push(ox, oy, oz, tx, ty, tz);
            globeColors.push(cr, cg, cb, cr, cg, cb);

            const hLen = arrowLen * HEAD_FRAC;
            const lwx = tx + (-dxn * cosA + px * sinA) * hLen;
            const lwy = ty + (-dyn * cosA + py * sinA) * hLen;
            const lwz = tz + (-dzn * cosA + pz * sinA) * hLen;
            const rwx = tx + (-dxn * cosA - px * sinA) * hLen;
            const rwy = ty + (-dyn * cosA - py * sinA) * hLen;
            const rwz = tz + (-dzn * cosA - pz * sinA) * hLen;

            globePositions.push(tx, ty, tz, lwx, lwy, lwz);
            globeColors.push(cr, cg, cb, cr, cg, cb);
            globePositions.push(tx, ty, tz, rwx, rwy, rwz);
            globeColors.push(cr, cg, cb, cr, cg, cb);
        }

        // ── Map arrows: 2D with arrowhead ──
        {
            let ex = z, ey = 0, ez = -x;
            const elen = Math.sqrt(ex * ex + ez * ez);
            if (elen > 1e-10) { ex /= elen; ez /= elen; }
            else { ex = 1; ez = 0; }

            let nx = y * ez - z * ey;
            let ny = z * ex - x * ez;
            let nz = x * ey - y * ex;
            const nlen = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
            nx /= nlen; ny /= nlen; nz /= nlen;

            const dirX = ce * ex + cn * nx;
            const dirY = ce * ey + cn * ny;
            const dirZ = ce * ez + cn * nz;
            const dirLen = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ) || 1;
            const mapDir = projectMapDirectionFromXyz(x, y, z, dirX / dirLen, dirY / dirLen, dirZ / dirLen, 0.035, projectionParams);
            if (!mapDir) continue;

            const arrowLen = 0.006 + Math.min(0.014, speed * 0.025);
            const mapLen = Math.sqrt(mapDir.dx * mapDir.dx + mapDir.dy * mapDir.dy) || 1;
            const dx = (mapDir.dx / mapLen) * arrowLen;
            const dy = (mapDir.dy / mapLen) * arrowLen;
            const mx = mapDir.x;
            const my = mapDir.y;
            const tipX = mx + dx, tipY = my + dy;

            mapPositions.push(mx, my, 0.002, tipX, tipY, 0.002);
            mapColors.push(cr, cg, cb, cr, cg, cb);

            const hLen = arrowLen * HEAD_FRAC;
            const dLen = Math.sqrt(dx * dx + dy * dy) || 1;
            const ndx = -dx / dLen, ndy = -dy / dLen;

            const lx = tipX + (ndx * cosA - ndy * sinA) * hLen;
            const ly = tipY + (ndx * sinA + ndy * cosA) * hLen;
            const rx = tipX + (ndx * cosA + ndy * sinA) * hLen;
            const ry = tipY + (-ndx * sinA + ndy * cosA) * hLen;

            mapPositions.push(tipX, tipY, 0.002, lx, ly, 0.002);
            mapColors.push(cr, cg, cb, cr, cg, cb);
            mapPositions.push(tipX, tipY, 0.002, rx, ry, 0.002);
            mapColors.push(cr, cg, cb, cr, cg, cb);
        }
    }

    console.log(`[OceanArrows] ${season}: ${globePositions.length / 18} arrows (from ${gridRegions.length} grid cells)`);

    state.oceanCurrentArrowGroup = new THREE.Group();

    if (globePositions.length > 0) {
        const gGeo = new THREE.BufferGeometry();
        gGeo.setAttribute('position', new THREE.Float32BufferAttribute(globePositions, 3));
        gGeo.setAttribute('color', new THREE.Float32BufferAttribute(globeColors, 3));
        const gMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false });
        const gLines = new THREE.LineSegments(gGeo, gMat);
        gLines.name = 'oceanGlobe';
        gLines.visible = !state.mapMode;
        state.oceanCurrentArrowGroup.add(gLines);
    }

    if (mapPositions.length > 0) {
        const mGeo = new THREE.BufferGeometry();
        mGeo.setAttribute('position', new THREE.Float32BufferAttribute(mapPositions, 3));
        mGeo.setAttribute('color', new THREE.Float32BufferAttribute(mapColors, 3));
        const mMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6 });
        const mLines = new THREE.LineSegments(mGeo, mMat);
        mLines.name = 'oceanMap';
        mLines.visible = state.mapMode;
        state.oceanCurrentArrowGroup.add(mLines);
    }

    scene.add(state.oceanCurrentArrowGroup);
}

// Export equirectangular map as PNG (async, with tiled rendering for large sizes).
export async function exportMap(type, width, onProgress) {
    if (!state.curData) return;

    // Yield so the browser paints the loading overlay before heavy work begins
    await new Promise(r => setTimeout(r, 50));

    const height = width / 2;
    const { mesh, r_xyz, t_xyz, r_elevation } = state.curData;
    const isBW = type === 'heightmap' || type === 'landheightmap' || type === 'landmask';
    const is16Bit = type === 'heightmap' || type === 'landheightmap';

    // Climate-dependent export types (Satellite / Köppen)
    const debugLayers = state.curData.debugLayers;
    const koppenArr = (type === 'biome' || type === 'koppen') ? (debugLayers && debugLayers.koppen) : null;
    const biomeSmoothed = (type === 'biome' && koppenArr) ? getCachedBiomeSmoothed(mesh, koppenArr, r_elevation) : null;

    // Build map triangles (same projection as buildMapMesh, chosen coloring, no grid)
    const { numSides, numTriangles } = mesh;
    const PI = Math.PI;
    const sx = 2 / PI;

    // For heightmap exports, precompute averaged elevation at each triangle center
    // (each triangle touches 3 regions). This enables smooth Gouraud interpolation
    // instead of flat hex-cell shading.
    let t_elev;
    if (is16Bit) {
        t_elev = new Float32Array(numTriangles);
        const tris = mesh.triangles;
        for (let t = 0; t < numTriangles; t++) {
            const s0 = 3 * t;
            t_elev[t] = (r_elevation[tris[s0]] + r_elevation[tris[s0 + 1]] + r_elevation[tris[s0 + 2]]) / 3;
        }
    }

    const posArr = new Float32Array(numSides * 18);
    const colArr = new Float32Array(numSides * 18);
    let triCount = 0;

    for (let s = 0; s < numSides; s++) {
        const it = mesh.s_inner_t(s);
        const ot = mesh.s_outer_t(s);
        const br = mesh.s_begin_r(s);

        // Per-vertex colors: c0 = inner_t vertex, c1 = outer_t vertex, c2 = region vertex
        let c0r, c0g, c0b, c1r, c1g, c1b, c2r, c2g, c2b;
        if (is16Bit) {
            // Smooth heightmap: triangle-center vertices use averaged elevation
            const colorFn = type === 'landheightmap' ? landHeightmapColor : heightmapColor;
            const v0 = colorFn(t_elev[it])[0];
            const v1 = colorFn(t_elev[ot])[0];
            const v2 = colorFn(r_elevation[br])[0];
            c0r = c0g = c0b = v0;
            c1r = c1g = c1b = v1;
            c2r = c2g = c2b = v2;
        } else {
            let cr, cg, cb;
            if (type === 'landmask') {
                [cr, cg, cb] = landMaskColor(r_elevation[br]);
            } else if (type === 'biome' && biomeSmoothed) {
                cr = biomeSmoothed[br * 3]; cg = biomeSmoothed[br * 3 + 1]; cb = biomeSmoothed[br * 3 + 2];
            } else if (type === 'koppen' && koppenArr) {
                [cr, cg, cb] = koppenColor(koppenArr[br]);
            } else {
                [cr, cg, cb] = elevationToColor(r_elevation[br]);
            }
            c0r = c1r = c2r = cr;
            c0g = c1g = c2g = cg;
            c0b = c1b = c2b = cb;
        }

        const x0 = t_xyz[3*it], y0 = t_xyz[3*it+1], z0 = t_xyz[3*it+2];
        const x1 = t_xyz[3*ot], y1 = t_xyz[3*ot+1], z1 = t_xyz[3*ot+2];
        const x2 = r_xyz[3*br], y2 = r_xyz[3*br+1], z2 = r_xyz[3*br+2];

        let lon0 = Math.atan2(x0, z0), lat0 = Math.asin(Math.max(-1, Math.min(1, y0)));
        let lon1 = Math.atan2(x1, z1), lat1 = Math.asin(Math.max(-1, Math.min(1, y1)));
        let lon2 = Math.atan2(x2, z2), lat2 = Math.asin(Math.max(-1, Math.min(1, y2)));

        const clx = (v) => Math.max(-2, Math.min(2, v));
        const cly = (v) => Math.max(-1, Math.min(1, v));

        const maxLon = Math.max(lon0, lon1, lon2);
        const minLon = Math.min(lon0, lon1, lon2);
        const wraps = (maxLon - minLon) > PI;

        if (wraps) {
            if (lon0 < 0) lon0 += 2 * PI;
            if (lon1 < 0) lon1 += 2 * PI;
            if (lon2 < 0) lon2 += 2 * PI;

            let off = triCount * 9;
            posArr[off]   = clx(lon0*sx); posArr[off+1] = cly(lat0*sx); posArr[off+2] = 0;
            posArr[off+3] = clx(lon1*sx); posArr[off+4] = cly(lat1*sx); posArr[off+5] = 0;
            posArr[off+6] = clx(lon2*sx); posArr[off+7] = cly(lat2*sx); posArr[off+8] = 0;
            colArr[off]=c0r; colArr[off+1]=c0g; colArr[off+2]=c0b;
            colArr[off+3]=c1r; colArr[off+4]=c1g; colArr[off+5]=c1b;
            colArr[off+6]=c2r; colArr[off+7]=c2g; colArr[off+8]=c2b;
            triCount++;

            off = triCount * 9;
            posArr[off]   = clx((lon0-2*PI)*sx); posArr[off+1] = cly(lat0*sx); posArr[off+2] = 0;
            posArr[off+3] = clx((lon1-2*PI)*sx); posArr[off+4] = cly(lat1*sx); posArr[off+5] = 0;
            posArr[off+6] = clx((lon2-2*PI)*sx); posArr[off+7] = cly(lat2*sx); posArr[off+8] = 0;
            colArr[off]=c0r; colArr[off+1]=c0g; colArr[off+2]=c0b;
            colArr[off+3]=c1r; colArr[off+4]=c1g; colArr[off+5]=c1b;
            colArr[off+6]=c2r; colArr[off+7]=c2g; colArr[off+8]=c2b;
            triCount++;
        } else {
            const off = triCount * 9;
            posArr[off]   = clx(lon0*sx); posArr[off+1] = cly(lat0*sx); posArr[off+2] = 0;
            posArr[off+3] = clx(lon1*sx); posArr[off+4] = cly(lat1*sx); posArr[off+5] = 0;
            posArr[off+6] = clx(lon2*sx); posArr[off+7] = cly(lat2*sx); posArr[off+8] = 0;
            colArr[off]=c0r; colArr[off+1]=c0g; colArr[off+2]=c0b;
            colArr[off+3]=c1r; colArr[off+4]=c1g; colArr[off+5]=c1b;
            colArr[off+6]=c2r; colArr[off+7]=c2g; colArr[off+8]=c2b;
            triCount++;
        }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(posArr.buffer, 0, triCount * 9), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(colArr.buffer, 0, triCount * 9), 3));

    const mapMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));

    const offScene = new THREE.Scene();
    offScene.background = isBW ? new THREE.Color(0x000000) : new THREE.Color(0x1a1a2e);
    offScene.add(mapMesh);

    // Tiled rendering — split into small tiles to stay within GPU/CPU memory limits.
    // Cap at 2048 regardless of GPU maxTextureSize to keep render-target + pixel-
    // readback + ImageData under ~48 MB per tile (2048×2048×4 × 3 buffers).
    const maxTex = renderer.capabilities.maxTextureSize;
    const MAX_TILE = 2048;
    const tileW = Math.min(width, maxTex, MAX_TILE);
    const tileH = Math.min(height, maxTex, MAX_TILE);
    const tilesX = Math.ceil(width / tileW);
    const tilesY = Math.ceil(height / tileH);
    const totalTiles = tilesX * tilesY;

    // 16-bit heightmaps write to a Uint16Array; other types use a canvas
    let cvs, ctx, img16;
    if (is16Bit) {
        img16 = new Uint16Array(width * height);
    } else {
        cvs = document.createElement('canvas');
        cvs.width = width;
        cvs.height = height;
        ctx = cvs.getContext('2d');
    }

    let tilesDone = 0;
    for (let ty = 0; ty < tilesY; ty++) {
        for (let tx = 0; tx < tilesX; tx++) {
            const px0 = tx * tileW;
            const py0 = ty * tileH;
            const pw = Math.min(tileW, width - px0);
            const ph = Math.min(tileH, height - py0);

            // Orthographic frustum for this tile (map space: x [-2,2], y [-1,1])
            const left   = -2 + 4 * px0 / width;
            const right  = -2 + 4 * (px0 + pw) / width;
            const top    =  1 - 2 * py0 / height;
            const bottom =  1 - 2 * (py0 + ph) / height;

            const cam = new THREE.OrthographicCamera(left, right, top, bottom, 0.1, 10);
            cam.position.set(0, 0, 5);
            cam.lookAt(0, 0, 0);

            if (is16Bit) {
                // Float render target preserves full precision of elevation values
                const renderTarget = new THREE.WebGLRenderTarget(pw, ph, { type: THREE.FloatType });
                const prevCS = renderer.outputColorSpace;
                renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
                renderer.setRenderTarget(renderTarget);
                renderer.render(offScene, cam);
                renderer.outputColorSpace = prevCS;

                const floatPixels = new Float32Array(pw * ph * 4);
                renderer.readRenderTargetPixels(renderTarget, 0, 0, pw, ph, floatPixels);
                renderer.setRenderTarget(null);
                renderTarget.dispose();

                // Write to img16 (flip rows, extract R channel → 16-bit)
                for (let y = 0; y < ph; y++) {
                    const srcRow = (ph - 1 - y) * pw;
                    const dstRow = (py0 + y) * width + px0;
                    for (let x = 0; x < pw; x++) {
                        const v = floatPixels[(srcRow + x) * 4]; // R channel
                        img16[dstRow + x] = Math.max(0, Math.min(65535, (v * 65535 + 0.5) | 0));
                    }
                }
            } else {
                const renderTarget = new THREE.WebGLRenderTarget(pw, ph);
                renderer.setRenderTarget(renderTarget);
                renderer.render(offScene, cam);

                const pixels = new Uint8Array(pw * ph * 4);
                renderer.readRenderTargetPixels(renderTarget, 0, 0, pw, ph, pixels);
                renderer.setRenderTarget(null);
                renderTarget.dispose();

                // Write tile to canvas (flip rows + sRGB gamma)
                const imageData = ctx.createImageData(pw, ph);
                const out = imageData.data;
                for (let y = 0; y < ph; y++) {
                    const src = (ph - 1 - y) * pw * 4;
                    const dst = y * pw * 4;
                    for (let x = 0; x < pw; x++) {
                        const si = src + x * 4, di = dst + x * 4;
                        for (let c = 0; c < 3; c++) {
                            const v = pixels[si + c] / 255;
                            out[di + c] = (v <= 0.0031308
                                ? v * 12.92
                                : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255 + 0.5 | 0;
                        }
                        out[di + 3] = pixels[si + 3];
                    }
                }
                ctx.putImageData(imageData, px0, py0);
            }

            tilesDone++;
            if (onProgress) onProgress(tilesDone / totalTiles * 80, '正在渲染...');
            await new Promise(r => setTimeout(r, 0));
        }
    }

    // Cleanup mesh
    geo.dispose();
    mapMesh.material.dispose();

    // Encode & download
    if (onProgress) onProgress(85, '正在编码 PNG...');
    await new Promise(r => setTimeout(r, 0));

    const code = location.hash.replace(/^#/, '').trim() || (state.curData ? state.curData.seed : '');
    const filename = exportFilename(type, code);

    if (is16Bit) {
        const blob = await encode16BitGrayscalePNG(width, height, img16);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    } else {
        await new Promise(resolve => {
            cvs.toBlob(blob => {
                if (blob) {
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = filename;
                    a.click();
                    setTimeout(() => URL.revokeObjectURL(url), 5000);
                }
                // Release canvas bitmap memory so sequential exports don't accumulate
                cvs.width = 0;
                cvs.height = 0;
                resolve();
            }, 'image/png');
        });
    }
}

function sanitizeFilePart(value) {
    return String(value || 'world').replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'world';
}

function exportTypeSlug(type) {
    return String(type || 'terrain')
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[^a-zA-Z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'terrain';
}

function currentExportSeed() {
    return sanitizeFilePart(location.hash.replace(/^#/, '').trim() || (state.curData ? state.curData.seed : 'world'));
}

export function exportFilename(type, seed) {
    const cleanSeed = sanitizeFilePart(seed);
    switch (type) {
        case 'color':          return `orogen-terrain-${cleanSeed}.png`;
        case 'landmask':       return `orogen-landmask-${cleanSeed}.png`;
        case 'landheightmap':  return `orogen-land-heightmap-${cleanSeed}.png`;
        case 'heightmap':      return `orogen-heightmap-${cleanSeed}.png`;
        case 'biome':          return `orogen-satellite-${cleanSeed}.png`;
        case 'koppen':         return `orogen-climate-${cleanSeed}.png`;
        default:               return `orogen-${exportTypeSlug(type)}-${cleanSeed}.png`;
    }
}

function is16BitExportType(type) {
    return type === 'heightmap' || type === 'landheightmap';
}

function isBWExportType(type) {
    return is16BitExportType(type) || type === 'landmask';
}

function makeExportColorContext(type, mesh, r_elevation, debugLayers, biomeSmoothed) {
    const ctx = { type, r_elevation, dbgArr: null, dbgMin: 0, dbgMax: 0 };
    const oceanSeason = type === 'oceanCurrentWinter' ? 'winter' : 'summer';
    ctx.oceanWarmth = (type === 'oceanCurrentSummer' || type === 'oceanCurrentWinter')
        ? state.curData[`r_ocean_warmth_${oceanSeason}`]
        : null;
    ctx.oceanSpeed = (type === 'oceanCurrentSummer' || type === 'oceanCurrentWinter')
        ? state.curData[`r_ocean_speed_${oceanSeason}`]
        : null;
    ctx.koppenArr = (type === 'koppen' || type === 'biome') ? (debugLayers && debugLayers.koppen) : null;
    ctx.biomeSmoothed = type === 'biome' ? biomeSmoothed : null;
    ctx.precipArr = (type === 'precipSummer' || type === 'precipWinter') ? (debugLayers && debugLayers[type]) : null;
    ctx.rainShadowArr = (type === 'rainShadowSummer' || type === 'rainShadowWinter') ? (debugLayers && debugLayers[type]) : null;
    ctx.tempArr = (type === 'tempSummer' || type === 'tempWinter') ? (debugLayers && debugLayers[type]) : null;
    ctx.contArr = type === 'continentality' ? (debugLayers && debugLayers.continentality) : null;
    ctx.tempContArr = type === 'tempContinentality' ? (debugLayers && debugLayers.tempContinentality) : null;

    const special = type === 'color' || type === 'heightmap' || type === 'landheightmap' ||
        type === 'landmask' || type === 'biome' || type === 'koppen' ||
        type === 'precipSummer' || type === 'precipWinter' ||
        type === 'rainShadowSummer' || type === 'rainShadowWinter' ||
        type === 'tempSummer' || type === 'tempWinter' ||
        type === 'continentality' || type === 'tempContinentality' ||
        type === 'oceanCurrentSummer' || type === 'oceanCurrentWinter';

    if (!special && debugLayers && debugLayers[type]) {
        ctx.dbgArr = debugLayers[type];
        for (let r = 0; r < mesh.numRegions; r++) {
            if (ctx.dbgArr[r] < ctx.dbgMin) ctx.dbgMin = ctx.dbgArr[r];
            if (ctx.dbgArr[r] > ctx.dbgMax) ctx.dbgMax = ctx.dbgArr[r];
        }
    }
    return ctx;
}

function exportRegionColor(ctx, br) {
    const type = ctx.type;
    if (type === 'landmask') return landMaskColor(ctx.r_elevation[br]);
    if (type === 'landheightmap') return landHeightmapColor(ctx.r_elevation[br]);
    if (type === 'heightmap') return heightmapColor(ctx.r_elevation[br]);
    if (type === 'biome' && ctx.biomeSmoothed) {
        return [ctx.biomeSmoothed[br * 3], ctx.biomeSmoothed[br * 3 + 1], ctx.biomeSmoothed[br * 3 + 2]];
    }
    if (type === 'koppen' && ctx.koppenArr) return koppenColor(ctx.koppenArr[br]);
    if ((type === 'precipSummer' || type === 'precipWinter') && ctx.precipArr) return precipitationColor(ctx.precipArr[br]);
    if ((type === 'rainShadowSummer' || type === 'rainShadowWinter') && ctx.rainShadowArr) return rainShadowColor(ctx.rainShadowArr[br]);
    if ((type === 'tempSummer' || type === 'tempWinter') && ctx.tempArr) return temperatureColor(ctx.tempArr[br]);
    if (type === 'continentality' && ctx.contArr) return continentalityColor(ctx.contArr[br]);
    if (type === 'tempContinentality' && ctx.tempContArr) return tempContinentalityColor(ctx.tempContArr[br]);
    if ((type === 'oceanCurrentSummer' || type === 'oceanCurrentWinter') && ctx.oceanWarmth && ctx.oceanSpeed) {
        return oceanCurrentColor(ctx.oceanWarmth[br], ctx.oceanSpeed[br], ctx.r_elevation[br] <= 0);
    }
    if (type === 'oceanCurrentSummer' || type === 'oceanCurrentWinter') return [0.5, 0, 0.5];
    if (ctx.dbgArr) return debugValueToColor(ctx.dbgArr[br], ctx.dbgMin, ctx.dbgMax);
    return elevationToColor(ctx.r_elevation[br]);
}

// Batch export — builds geometry once, recolors per type. Set download:false
// to collect texture files for a ZIP bundle instead of clicking each PNG.
export async function exportMapBatch(types, width, onProgress, options = {}) {
    if (!state.curData) return [];

    await new Promise(r => setTimeout(r, 50));

    const height = width / 2;
    const { mesh, r_xyz, t_xyz, r_elevation } = state.curData;
    const debugLayers = state.curData.debugLayers;
    const koppenArr = debugLayers && debugLayers.koppen;
    const biomeSmoothed = koppenArr ? getCachedBiomeSmoothed(mesh, koppenArr, r_elevation) : null;
    const { numSides, numTriangles } = mesh;
    const PI = Math.PI;
    const sx = 2 / PI;
    const download = options.download !== false;
    const pathPrefix = options.pathPrefix || '';
    const files = [];

    const t_elev = new Float32Array(numTriangles);
    const tris = mesh.triangles;
    for (let t = 0; t < numTriangles; t++) {
        const s0 = 3 * t;
        t_elev[t] = (r_elevation[tris[s0]] + r_elevation[tris[s0 + 1]] + r_elevation[tris[s0 + 2]]) / 3;
    }

    const posArr = new Float32Array(numSides * 18);
    const triRegions = new Uint32Array(numSides * 2);
    const triInnerT = new Uint32Array(numSides * 2);
    const triOuterT = new Uint32Array(numSides * 2);
    let triCount = 0;

    for (let s = 0; s < numSides; s++) {
        const it = mesh.s_inner_t(s);
        const ot = mesh.s_outer_t(s);
        const br = mesh.s_begin_r(s);
        const x0 = t_xyz[3*it], y0 = t_xyz[3*it+1], z0 = t_xyz[3*it+2];
        const x1 = t_xyz[3*ot], y1 = t_xyz[3*ot+1], z1 = t_xyz[3*ot+2];
        const x2 = r_xyz[3*br], y2 = r_xyz[3*br+1], z2 = r_xyz[3*br+2];
        let lon0 = Math.atan2(x0, z0), lat0 = Math.asin(Math.max(-1, Math.min(1, y0)));
        let lon1 = Math.atan2(x1, z1), lat1 = Math.asin(Math.max(-1, Math.min(1, y1)));
        let lon2 = Math.atan2(x2, z2), lat2 = Math.asin(Math.max(-1, Math.min(1, y2)));
        const clx = (v) => Math.max(-2, Math.min(2, v));
        const cly = (v) => Math.max(-1, Math.min(1, v));
        const maxLon = Math.max(lon0, lon1, lon2);
        const minLon = Math.min(lon0, lon1, lon2);
        const wraps = (maxLon - minLon) > PI;

        if (wraps) {
            if (lon0 < 0) lon0 += 2 * PI;
            if (lon1 < 0) lon1 += 2 * PI;
            if (lon2 < 0) lon2 += 2 * PI;

            let off = triCount * 9;
            posArr[off] = clx(lon0*sx); posArr[off+1] = cly(lat0*sx); posArr[off+2] = 0;
            posArr[off+3] = clx(lon1*sx); posArr[off+4] = cly(lat1*sx); posArr[off+5] = 0;
            posArr[off+6] = clx(lon2*sx); posArr[off+7] = cly(lat2*sx); posArr[off+8] = 0;
            triRegions[triCount] = br; triInnerT[triCount] = it; triOuterT[triCount] = ot;
            triCount++;

            off = triCount * 9;
            posArr[off] = clx((lon0-2*PI)*sx); posArr[off+1] = cly(lat0*sx); posArr[off+2] = 0;
            posArr[off+3] = clx((lon1-2*PI)*sx); posArr[off+4] = cly(lat1*sx); posArr[off+5] = 0;
            posArr[off+6] = clx((lon2-2*PI)*sx); posArr[off+7] = cly(lat2*sx); posArr[off+8] = 0;
            triRegions[triCount] = br; triInnerT[triCount] = it; triOuterT[triCount] = ot;
            triCount++;
        } else {
            const off = triCount * 9;
            posArr[off] = clx(lon0*sx); posArr[off+1] = cly(lat0*sx); posArr[off+2] = 0;
            posArr[off+3] = clx(lon1*sx); posArr[off+4] = cly(lat1*sx); posArr[off+5] = 0;
            posArr[off+6] = clx(lon2*sx); posArr[off+7] = cly(lat2*sx); posArr[off+8] = 0;
            triRegions[triCount] = br; triInnerT[triCount] = it; triOuterT[triCount] = ot;
            triCount++;
        }
    }

    const posData = new Float32Array(posArr.buffer, 0, triCount * 9);
    const offScene = new THREE.Scene();
    const maxTex = renderer.capabilities.maxTextureSize;
    const MAX_TILE = 2048;
    const tileW = Math.min(width, maxTex, MAX_TILE);
    const tileH = Math.min(height, maxTex, MAX_TILE);
    const tilesX = Math.ceil(width / tileW);
    const tilesY = Math.ceil(height / tileH);
    const totalTiles = tilesX * tilesY;
    const code = currentExportSeed();
    const total = types.length;
    const pixelBuf = new Uint8Array(tileW * tileH * 4);
    const floatBuf = new Float32Array(tileW * tileH * 4);
    const cvs = document.createElement('canvas');
    cvs.width = width;
    cvs.height = height;
    const ctx = cvs.getContext('2d');

    for (let ti = 0; ti < total; ti++) {
        const { type, label = type } = types[ti];
        const isBW = isBWExportType(type);
        const is16Bit = is16BitExportType(type);
        const colorCtx = makeExportColorContext(type, mesh, r_elevation, debugLayers, biomeSmoothed);
        offScene.background = isBW ? new THREE.Color(0x000000) : new THREE.Color(0x1a1a2e);
        let img16;
        if (is16Bit) img16 = new Uint16Array(width * height);

        const colData = new Float32Array(triCount * 9);
        for (let i = 0; i < triCount; i++) {
            const br = triRegions[i];
            const off = i * 9;
            if (is16Bit) {
                const colorFn = type === 'landheightmap' ? landHeightmapColor : heightmapColor;
                const v0 = colorFn(t_elev[triInnerT[i]])[0];
                const v1 = colorFn(t_elev[triOuterT[i]])[0];
                const v2 = colorFn(r_elevation[br])[0];
                colData[off] = colData[off+1] = colData[off+2] = v0;
                colData[off+3] = colData[off+4] = colData[off+5] = v1;
                colData[off+6] = colData[off+7] = colData[off+8] = v2;
            } else {
                const [cr, cg, cb] = exportRegionColor(colorCtx, br);
                colData[off] = colData[off+3] = colData[off+6] = cr;
                colData[off+1] = colData[off+4] = colData[off+7] = cg;
                colData[off+2] = colData[off+5] = colData[off+8] = cb;
            }
        }

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(posData, 3));
        geo.setAttribute('color', new THREE.BufferAttribute(colData, 3));
        const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
        const mapMesh = new THREE.Mesh(geo, mat);
        offScene.add(mapMesh);

        let tilesDone = 0;
        for (let ty = 0; ty < tilesY; ty++) {
            for (let tx = 0; tx < tilesX; tx++) {
                const px0 = tx * tileW;
                const py0 = ty * tileH;
                const pw = Math.min(tileW, width - px0);
                const ph = Math.min(tileH, height - py0);
                const left = -2 + 4 * px0 / width;
                const right = -2 + 4 * (px0 + pw) / width;
                const top = 1 - 2 * py0 / height;
                const bottom = 1 - 2 * (py0 + ph) / height;
                const cam = new THREE.OrthographicCamera(left, right, top, bottom, 0.1, 10);
                cam.position.set(0, 0, 5);
                cam.lookAt(0, 0, 0);

                if (is16Bit) {
                    const renderTarget = new THREE.WebGLRenderTarget(pw, ph, { type: THREE.FloatType });
                    const prevCS = renderer.outputColorSpace;
                    renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
                    renderer.setRenderTarget(renderTarget);
                    renderer.render(offScene, cam);
                    renderer.outputColorSpace = prevCS;
                    renderer.readRenderTargetPixels(renderTarget, 0, 0, pw, ph, floatBuf);
                    renderer.setRenderTarget(null);
                    renderTarget.dispose();

                    for (let y = 0; y < ph; y++) {
                        const srcRow = (ph - 1 - y) * pw;
                        const dstRow = (py0 + y) * width + px0;
                        for (let x = 0; x < pw; x++) {
                            const v = floatBuf[(srcRow + x) * 4];
                            img16[dstRow + x] = Math.max(0, Math.min(65535, (v * 65535 + 0.5) | 0));
                        }
                    }
                } else {
                    const renderTarget = new THREE.WebGLRenderTarget(pw, ph);
                    renderer.setRenderTarget(renderTarget);
                    renderer.render(offScene, cam);
                    renderer.readRenderTargetPixels(renderTarget, 0, 0, pw, ph, pixelBuf);
                    renderer.setRenderTarget(null);
                    renderTarget.dispose();

                    const imageData = ctx.createImageData(pw, ph);
                    const out = imageData.data;
                    for (let y = 0; y < ph; y++) {
                        const src = (ph - 1 - y) * pw * 4;
                        const dst = y * pw * 4;
                        for (let x = 0; x < pw; x++) {
                            const si = src + x * 4, di = dst + x * 4;
                            for (let c = 0; c < 3; c++) {
                                const v = pixelBuf[si + c] / 255;
                                out[di + c] = (v <= 0.0031308
                                    ? v * 12.92
                                    : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255 + 0.5 | 0;
                            }
                            out[di + 3] = pixelBuf[si + 3];
                        }
                    }
                    ctx.putImageData(imageData, px0, py0);
                }

                tilesDone++;
                if (onProgress) onProgress(tilesDone / totalTiles * 80, `正在导出 ${label} (${ti+1}/${total})：渲染中...`);
                await new Promise(r => setTimeout(r, 0));
            }
        }

        offScene.remove(mapMesh);
        geo.dispose();
        mat.dispose();
        if (onProgress) onProgress(85, `正在导出 ${label} (${ti+1}/${total})：编码 PNG...`);
        await new Promise(r => setTimeout(r, 0));

        const filename = exportFilename(type, code);
        let blob;
        if (is16Bit) {
            blob = await encode16BitGrayscalePNG(width, height, img16);
        } else {
            blob = await new Promise(resolve => cvs.toBlob(resolve, 'image/png'));
        }

        if (blob) {
            if (download) {
                downloadBlob(filename, blob);
            } else {
                files.push({ path: pathPrefix + filename, data: blob, compress: false });
            }
        }

        await new Promise(r => setTimeout(r, 100));
    }

    cvs.width = 0;
    cvs.height = 0;
    return files;
}

function modelTextureUri(seed) {
    return `../textures/${exportFilename('color', seed)}`;
}

function getPlanetModelData() {
    if (!state.planetMesh && state.curData) buildMesh();
    const posAttr = state.planetMesh && state.planetMesh.geometry.getAttribute('position');
    if (!posAttr) return null;

    const positions = new Float32Array(posAttr.array);
    const vertexCount = posAttr.count;
    const normals = new Float32Array(vertexCount * 3);
    const uvs = new Float32Array(vertexCount * 2);
    const colors = new Uint8Array(vertexCount * 3);
    const { mesh, r_elevation } = state.curData;
    const PI = Math.PI;

    for (let i = 0; i < vertexCount; i++) {
        const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
        const len = Math.hypot(x, y, z) || 1;
        const nx = x / len, ny = y / len, nz = z / len;
        normals[i * 3] = nx; normals[i * 3 + 1] = ny; normals[i * 3 + 2] = nz;
        uvs[i * 2] = 0.5 + Math.atan2(nx, nz) / (2 * PI);
        uvs[i * 2 + 1] = 0.5 - Math.asin(Math.max(-1, Math.min(1, ny))) / PI;
    }

    for (let i = 0; i < vertexCount; i += 3) {
        const u0 = uvs[i * 2], u1 = uvs[(i + 1) * 2], u2 = uvs[(i + 2) * 2];
        if (Math.max(u0, u1, u2) - Math.min(u0, u1, u2) > 0.5) {
            for (let j = 0; j < 3; j++) {
                const k = (i + j) * 2;
                if (uvs[k] < 0.5) uvs[k] += 1;
            }
        }
    }

    for (let s = 0; s < mesh.numSides; s++) {
        const br = mesh.s_begin_r(s);
        const [r, g, b] = elevationToColor(r_elevation[br]);
        for (let j = 0; j < 3; j++) {
            const off = (s * 3 + j) * 3;
            colors[off] = Math.round(r * 255);
            colors[off + 1] = Math.round(g * 255);
            colors[off + 2] = Math.round(b * 255);
        }
    }

    return { positions, normals, uvs, colors, vertexCount, faceCount: vertexCount / 3 };
}

function fmt(v) {
    return Number(v).toFixed(6).replace(/\.?0+$/, '');
}

function exportObjModel(seed, textureUri) {
    const data = getPlanetModelData();
    if (!data) return [];
    const base = `orogen-world-${sanitizeFilePart(seed)}`;
    const obj = [
        `mtllib ${base}.mtl`,
        'o World_Orogen',
        'usemtl terrain',
    ];
    for (let i = 0; i < data.vertexCount; i++) {
        obj.push(`v ${fmt(data.positions[i*3])} ${fmt(data.positions[i*3+1])} ${fmt(data.positions[i*3+2])}`);
    }
    for (let i = 0; i < data.vertexCount; i++) {
        obj.push(`vt ${fmt(data.uvs[i*2])} ${fmt(data.uvs[i*2+1])}`);
    }
    for (let i = 0; i < data.vertexCount; i++) {
        obj.push(`vn ${fmt(data.normals[i*3])} ${fmt(data.normals[i*3+1])} ${fmt(data.normals[i*3+2])}`);
    }
    for (let i = 0; i < data.vertexCount; i += 3) {
        obj.push(`f ${i+1}/${i+1}/${i+1} ${i+2}/${i+2}/${i+2} ${i+3}/${i+3}/${i+3}`);
    }

    const mtl = [
        'newmtl terrain',
        'Ka 1 1 1',
        'Kd 1 1 1',
        'Ks 0 0 0',
        'd 1',
        `map_Kd ${textureUri}`,
        '',
    ].join('\n');

    return [
        { path: `models/${base}.obj`, data: obj.join('\n') + '\n' },
        { path: `models/${base}.mtl`, data: mtl },
    ];
}

function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

function appendAligned(parts, bytes) {
    let offset = parts.reduce((sum, p) => sum + p.length, 0);
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
        parts.push(new Uint8Array(pad));
        offset += pad;
    }
    parts.push(bytes);
    return offset;
}

function exportPlyModel(seed) {
    const data = getPlanetModelData();
    if (!data) return [];
    const base = `orogen-world-${sanitizeFilePart(seed)}`;
    const lines = [
        'ply',
        'format ascii 1.0',
        'comment Generated by World Orogen',
        `element vertex ${data.vertexCount}`,
        'property float x',
        'property float y',
        'property float z',
        'property uchar red',
        'property uchar green',
        'property uchar blue',
        `element face ${data.faceCount}`,
        'property list uchar int vertex_indices',
        'end_header',
    ];
    for (let i = 0; i < data.vertexCount; i++) {
        lines.push(`${fmt(data.positions[i*3])} ${fmt(data.positions[i*3+1])} ${fmt(data.positions[i*3+2])} ${data.colors[i*3]} ${data.colors[i*3+1]} ${data.colors[i*3+2]}`);
    }
    for (let i = 0; i < data.vertexCount; i += 3) {
        lines.push(`3 ${i} ${i + 1} ${i + 2}`);
    }
    return [{ path: `models/${base}.ply`, data: lines.join('\n') + '\n' }];
}

async function exportGltfModelAsync(seed, textureUri) {
    const data = getPlanetModelData();
    if (!data) return [];
    const base = `orogen-world-${sanitizeFilePart(seed)}`;
    const parts = [];
    const posBytes = new Uint8Array(data.positions.buffer);
    const normBytes = new Uint8Array(data.normals.buffer);
    const uvBytes = new Uint8Array(data.uvs.buffer);
    const posOffset = appendAligned(parts, posBytes);
    const normOffset = appendAligned(parts, normBytes);
    const uvOffset = appendAligned(parts, uvBytes);
    const blob = new Blob(parts);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < data.vertexCount; i++) {
        for (let c = 0; c < 3; c++) {
            const v = data.positions[i * 3 + c];
            if (v < min[c]) min[c] = v;
            if (v > max[c]) max[c] = v;
        }
    }

    const gltf = {
        asset: { version: '2.0', generator: 'World Orogen' },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0, name: 'World Orogen Terrain' }],
        meshes: [{
            name: 'World Orogen Terrain',
            primitives: [{
                attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 },
                material: 0,
                mode: 4,
            }],
        }],
        materials: [{
            name: 'terrain',
            pbrMetallicRoughness: {
                baseColorTexture: { index: 0 },
                metallicFactor: 0,
                roughnessFactor: 1,
            },
            doubleSided: true,
        }],
        images: [{ uri: textureUri }],
        textures: [{ source: 0, sampler: 0 }],
        samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }],
        buffers: [{
            uri: `data:application/octet-stream;base64,${bytesToBase64(bytes)}`,
            byteLength: bytes.length,
        }],
        bufferViews: [
            { buffer: 0, byteOffset: posOffset, byteLength: posBytes.length, target: 34962 },
            { buffer: 0, byteOffset: normOffset, byteLength: normBytes.length, target: 34962 },
            { buffer: 0, byteOffset: uvOffset, byteLength: uvBytes.length, target: 34962 },
        ],
        accessors: [
            { bufferView: 0, componentType: 5126, count: data.vertexCount, type: 'VEC3', min, max },
            { bufferView: 1, componentType: 5126, count: data.vertexCount, type: 'VEC3' },
            { bufferView: 2, componentType: 5126, count: data.vertexCount, type: 'VEC2' },
        ],
    };
    return [{ path: `models/${base}.gltf`, data: JSON.stringify(gltf, null, 2) }];
}

async function exportPlanetModelFiles(format, seed, textureUri) {
    if (format === 'obj') return exportObjModel(seed, textureUri);
    if (format === 'ply') return exportPlyModel(seed);
    if (format === 'gltf') return exportGltfModelAsync(seed, textureUri);
    return [];
}

export async function exportWorldBundle({ width, textureTypes, modelFormat = '' }, onProgress) {
    if (!state.curData) return null;
    const seed = currentExportSeed();
    const selected = [];
    const seen = new Set();
    for (const item of textureTypes || []) {
        if (!item || !item.type || seen.has(item.type)) continue;
        selected.push(item);
        seen.add(item.type);
    }

    if (onProgress) onProgress(0, '正在准备世界包...');
    const textureFiles = await exportMapBatch(selected, width, (pct, label) => {
        if (onProgress) onProgress(pct * 0.82, label);
    }, { download: false, pathPrefix: 'textures/' });

    const files = [...textureFiles];
    if (modelFormat) {
        if (onProgress) onProgress(84, '正在生成球体模型...');
        files.push(...await exportPlanetModelFiles(modelFormat, seed, modelTextureUri(seed)));
    }

    const manifestPath = 'manifest.json';
    files.push({
        path: manifestPath,
        data: JSON.stringify({
            generator: 'World Orogen',
            seed,
            textureWidth: width,
            textureHeight: width / 2,
            textures: textureFiles.map(f => f.path),
            modelFormat: modelFormat || null,
            files: [...files.map(f => f.path), manifestPath],
        }, null, 2),
    });

    if (onProgress) onProgress(90, '正在生成 ZIP 素材包...');
    const zip = await createZipBlob(files, (pct, label) => {
        if (onProgress) onProgress(90 + pct * 0.09, label);
    });
    const filename = `orogen-world-${seed}.zip`;
    downloadBlob(filename, zip);
    if (onProgress) onProgress(100, '世界包已导出');
    return { filename, files: files.map(f => f.path) };
}
