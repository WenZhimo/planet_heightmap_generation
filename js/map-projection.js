import { state } from './state.js';

const PI = Math.PI;
const HALF_PI = PI / 2;
const TAU = PI * 2;
const DEG = PI / 180;
const EPS = 1e-6;
const MAX_MERCATOR_LAT = 85 * DEG;
const AZIMUTHAL_EQUAL_AREA_MIN_Z = Math.cos((180 - 2) * DEG);
const AZIMUTHAL_EQUAL_AREA_MAX_R = Math.sqrt(2 * (1 - AZIMUTHAL_EQUAL_AREA_MIN_Z));
const AZIMUTHAL_EQUAL_AREA_MAX_RAW_EDGE = 0.32;

const EQ_A1 = 1.340264;
const EQ_A2 = -0.081106;
const EQ_A3 = 0.000893;
const EQ_A4 = 0.003796;
const EQ_M = Math.sqrt(3) / 2;

export const MAP_PROJECTIONS = [
    { id: 'equirectangular', label: '等距柱状' },
    { id: 'mercator', label: '墨卡托' },
    { id: 'naturalEarth1', label: '自然地球' },
    { id: 'equalEarth', label: 'Equal Earth 等面积' },
    { id: 'orthographic', label: '正射半球' },
    { id: 'azimuthalEqualArea', label: '方位等面积' },
    { id: 'stereographic', label: '球极平射' },
    { id: 'gnomonic', label: '心射投影' },
];

const PROJECTION_IDS = new Set(MAP_PROJECTIONS.map(p => p.id));

function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

function asin(v) {
    return Math.asin(clamp(v, -1, 1));
}

export function wrapRadians(v) {
    if (v > PI || v < -PI) v -= Math.round(v / TAU) * TAU;
    return v;
}

export function formatLonLabel(deg) {
    const suffix = deg > 0 ? '东' : deg < 0 ? '西' : '';
    return Math.abs(deg) + '°' + suffix;
}

export function formatLatLabel(deg) {
    const suffix = deg > 0 ? '北' : deg < 0 ? '南' : '';
    return Math.abs(deg) + '°' + suffix;
}

export function getMapProjectionLabel(id = state.mapProjection) {
    return MAP_PROJECTIONS.find(p => p.id === id)?.label || MAP_PROJECTIONS[0].label;
}

function projectionId() {
    return PROJECTION_IDS.has(state.mapProjection) ? state.mapProjection : 'equirectangular';
}

function projectionScale(id) {
    switch (id) {
        case 'mercator':
            return 0.98 / mercatorY(MAX_MERCATOR_LAT);
        case 'naturalEarth1': {
            const xmax = naturalEarth1Raw(PI, 0)[0];
            const ymax = naturalEarth1Raw(0, HALF_PI)[1];
            return 0.98 * Math.min(2 / xmax, 1 / ymax);
        }
        case 'equalEarth': {
            const xmax = equalEarthRaw(PI, 0)[0];
            const ymax = equalEarthRaw(0, HALF_PI)[1];
            return 0.98 * Math.min(2 / xmax, 1 / ymax);
        }
        case 'orthographic':
            return 0.98;
        case 'azimuthalEqualArea':
            return 0.49;
        case 'stereographic':
            return 0.28;
        case 'gnomonic':
            return 0.62;
        case 'equirectangular':
        default:
            return 2 / PI;
    }
}

export function getMapProjectionParams() {
    const id = projectionId();
    return {
        id,
        centerLon: state.mapCenterLon || 0,
        centerLat: clamp(state.mapCenterLat || 0, -HALF_PI, HALF_PI),
        rotation: state.mapRotation || 0,
        scale: projectionScale(id),
        wrap: id === 'equirectangular' || id === 'mercator' || id === 'naturalEarth1' || id === 'equalEarth',
    };
}

function mercatorY(phi) {
    return Math.log(Math.tan((HALF_PI + phi) / 2));
}

function naturalEarth1Raw(lambda, phi) {
    const phi2 = phi * phi;
    const phi4 = phi2 * phi2;
    return [
        lambda * (0.8707 - 0.131979 * phi2 + phi4 * (-0.013791 + phi4 * (0.003971 * phi2 - 0.001529 * phi4))),
        phi * (1.007226 + phi2 * (0.015085 + phi4 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4))),
    ];
}

function invertNaturalEarth1Raw(x, y) {
    let phi = y;
    let delta = 0;
    for (let i = 0; i < 25; i++) {
        const phi2 = phi * phi;
        const phi4 = phi2 * phi2;
        const fy = phi * (1.007226 + phi2 * (0.015085 + phi4 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4))) - y;
        const fpy = 1.007226 + phi2 * (0.015085 * 3 + phi4 * (-0.044475 * 7 + 0.028874 * 9 * phi2 - 0.005916 * 11 * phi4));
        if (Math.abs(fpy) < EPS) return null;
        phi -= delta = fy / fpy;
        if (Math.abs(delta) <= EPS) break;
    }
    const phi2 = phi * phi;
    const denom = 0.8707 + phi2 * (-0.131979 + phi2 * (-0.013791 + phi2 * phi2 * phi2 * (0.003971 - 0.001529 * phi2)));
    if (Math.abs(denom) < EPS) return null;
    return [x / denom, phi];
}

function equalEarthRaw(lambda, phi) {
    const l = asin(EQ_M * Math.sin(phi));
    const l2 = l * l;
    const l6 = l2 * l2 * l2;
    return [
        lambda * Math.cos(l) / (EQ_M * (EQ_A1 + 3 * EQ_A2 * l2 + l6 * (7 * EQ_A3 + 9 * EQ_A4 * l2))),
        l * (EQ_A1 + EQ_A2 * l2 + l6 * (EQ_A3 + EQ_A4 * l2)),
    ];
}

function invertEqualEarthRaw(x, y) {
    let l = y;
    let delta = 0;
    for (let i = 0; i < 12; i++) {
        const l2 = l * l;
        const l6 = l2 * l2 * l2;
        const fy = l * (EQ_A1 + EQ_A2 * l2 + l6 * (EQ_A3 + EQ_A4 * l2)) - y;
        const fpy = EQ_A1 + 3 * EQ_A2 * l2 + l6 * (7 * EQ_A3 + 9 * EQ_A4 * l2);
        if (Math.abs(fpy) < EPS) return null;
        l -= delta = fy / fpy;
        if (Math.abs(delta) < 1e-12) break;
    }
    const l2 = l * l;
    const l6 = l2 * l2 * l2;
    const denom = Math.cos(l);
    if (Math.abs(denom) < EPS) return null;
    return [
        EQ_M * x * (EQ_A1 + 3 * EQ_A2 * l2 + l6 * (7 * EQ_A3 + 9 * EQ_A4 * l2)) / denom,
        asin(Math.sin(l) / EQ_M),
    ];
}

function vectorToLonLat(x, y, z) {
    return [Math.atan2(x, z), asin(y)];
}

function lonLatToVector(lon, lat) {
    const cosLat = Math.cos(lat);
    return [
        cosLat * Math.sin(lon),
        Math.sin(lat),
        cosLat * Math.cos(lon),
    ];
}

function dot3(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a, b) {
    return [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ];
}

function normalize3(v) {
    const len = Math.hypot(v[0], v[1], v[2]);
    return len > EPS ? [v[0] / len, v[1] / len, v[2] / len] : null;
}

function rotateVectorAroundAxis(v, axis, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const d = dot3(axis, v);
    return [
        v[0] * c + (axis[1] * v[2] - axis[2] * v[1]) * s + axis[0] * d * (1 - c),
        v[1] * c + (axis[2] * v[0] - axis[0] * v[2]) * s + axis[1] * d * (1 - c),
        v[2] * c + (axis[0] * v[1] - axis[1] * v[0]) * s + axis[2] * d * (1 - c),
    ];
}

function orientationFromParams(params) {
    const centerLon = params.centerLon || 0;
    const centerLat = clamp(params.centerLat || 0, -HALF_PI, HALF_PI);
    const rotation = params.rotation || 0;
    const sinLon = Math.sin(centerLon);
    const cosLon = Math.cos(centerLon);
    const sinLat = Math.sin(centerLat);
    const cosLat = Math.cos(centerLat);
    const sinRot = Math.sin(rotation);
    const cosRot = Math.cos(rotation);

    const east = [cosLon, 0, -sinLon];
    const north = [-sinLat * sinLon, cosLat, -sinLat * cosLon];
    const center = [cosLat * sinLon, sinLat, cosLat * cosLon];

    return {
        x: [
            cosRot * east[0] - sinRot * north[0],
            cosRot * east[1] - sinRot * north[1],
            cosRot * east[2] - sinRot * north[2],
        ],
        y: [
            sinRot * east[0] + cosRot * north[0],
            sinRot * east[1] + cosRot * north[1],
            sinRot * east[2] + cosRot * north[2],
        ],
        z: center,
    };
}

function paramsFromOrientation(orientation) {
    const center = normalize3(orientation.z);
    if (!center) return null;
    const centerLon = wrapRadians(Math.atan2(center[0], center[2]));
    const centerLat = asin(center[1]);
    const sinLon = Math.sin(centerLon);
    const cosLon = Math.cos(centerLon);
    const sinLat = Math.sin(centerLat);
    const cosLat = Math.cos(centerLat);
    const east = [cosLon, 0, -sinLon];
    const north = [-sinLat * sinLon, cosLat, -sinLat * cosLon];
    const screenX = normalize3(orientation.x);
    if (!screenX) return null;
    const rotation = Math.atan2(-dot3(screenX, north), dot3(screenX, east));
    return {
        centerLon,
        centerLat,
        rotation: wrapRadians(Number.isFinite(rotation) ? rotation : 0),
    };
}

function rotateOrientationBetweenVectors(from, to, orientation) {
    const a = normalize3(from);
    const b = normalize3(to);
    if (!a || !b) return null;
    const d = clamp(dot3(a, b), -1, 1);
    if (d > 1 - EPS) return orientation;

    let axis = normalize3(cross3(a, b));
    if (!axis) {
        axis = normalize3(cross3(a, [0, 1, 0])) || normalize3(cross3(a, [1, 0, 0]));
    }
    if (!axis) return null;

    const angle = Math.acos(d);
    return {
        x: rotateVectorAroundAxis(orientation.x, axis, angle),
        y: rotateVectorAroundAxis(orientation.y, axis, angle),
        z: rotateVectorAroundAxis(orientation.z, axis, angle),
    };
}

export function rotateMapProjectionParamsByDrag(startParams, startPoint, currentPoint, fallbackCenter = { x: 0, y: 0 }) {
    const startVec = mapPointToXyz(startPoint.x, startPoint.y, startParams);
    const currentVec = mapPointToXyz(currentPoint.x, currentPoint.y, startParams);
    if (startVec && currentVec) {
        const rotated = rotateOrientationBetweenVectors(currentVec, startVec, orientationFromParams(startParams));
        const next = rotated ? paramsFromOrientation(rotated) : null;
        if (next) return next;
    }

    const startAngle = Math.atan2(startPoint.y - fallbackCenter.y, startPoint.x - fallbackCenter.x);
    const currentAngle = Math.atan2(currentPoint.y - fallbackCenter.y, currentPoint.x - fallbackCenter.x);
    if (!Number.isFinite(startAngle) || !Number.isFinite(currentAngle)) return null;
    const nearCenter = Math.hypot(startPoint.x - fallbackCenter.x, startPoint.y - fallbackCenter.y) < EPS ||
        Math.hypot(currentPoint.x - fallbackCenter.x, currentPoint.y - fallbackCenter.y) < EPS;
    if (nearCenter) return null;
    return {
        centerLon: startParams.centerLon || 0,
        centerLat: startParams.centerLat || 0,
        rotation: wrapRadians((startParams.rotation || 0) + currentAngle - startAngle),
    };
}

export function rotateLonLatToMap(lon, lat, params = getMapProjectionParams()) {
    const dlon = wrapRadians(lon - params.centerLon);
    const sinLat = Math.sin(lat);
    const cosLat = Math.cos(lat);
    const sinCenter = Math.sin(params.centerLat);
    const cosCenter = Math.cos(params.centerLat);
    const cosDlon = Math.cos(dlon);
    const localX = cosLat * Math.sin(dlon);
    const localY = cosCenter * sinLat - sinCenter * cosLat * cosDlon;
    const localZ = sinCenter * sinLat + cosCenter * cosLat * cosDlon;
    const sinRot = Math.sin(params.rotation || 0);
    const cosRot = Math.cos(params.rotation || 0);
    const rotatedX = cosRot * localX - sinRot * localY;
    const rotatedY = sinRot * localX + cosRot * localY;

    return {
        x: rotatedX,
        y: rotatedY,
        z: localZ,
        lambda: Math.atan2(rotatedX, localZ),
        phi: asin(rotatedY),
    };
}

export function rotateXyzToMap(x, y, z, params = getMapProjectionParams()) {
    const [lon, lat] = vectorToLonLat(x, y, z);
    return rotateLonLatToMap(lon, lat, params);
}

function localToWorldVector(localX, localY, localZ, params) {
    const sinRot = Math.sin(params.rotation || 0);
    const cosRot = Math.cos(params.rotation || 0);
    const unrotatedX = cosRot * localX + sinRot * localY;
    const unrotatedY = -sinRot * localX + cosRot * localY;
    const sinCenter = Math.sin(params.centerLat);
    const cosCenter = Math.cos(params.centerLat);
    const sinLat = sinCenter * localZ + cosCenter * unrotatedY;
    const lat = asin(sinLat);
    const h = cosCenter * localZ - sinCenter * unrotatedY;
    const lon = wrapRadians(params.centerLon + Math.atan2(unrotatedX, h));
    return lonLatToVector(lon, lat);
}

function rawForward(id, lambda, phi, z) {
    switch (id) {
        case 'mercator':
            return [lambda, mercatorY(clamp(phi, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT))];
        case 'naturalEarth1':
            return naturalEarth1Raw(lambda, phi);
        case 'equalEarth':
            return equalEarthRaw(lambda, phi);
        case 'orthographic':
            if (z < -EPS) return null;
            return [Math.cos(phi) * Math.sin(lambda), Math.sin(phi)];
        case 'azimuthalEqualArea': {
            if (z <= AZIMUTHAL_EQUAL_AREA_MIN_Z) return null;
            const k = Math.sqrt(2 / Math.max(EPS, 1 + z));
            return [k * Math.cos(phi) * Math.sin(lambda), k * Math.sin(phi)];
        }
        case 'stereographic': {
            if (z <= -1 + EPS) return null;
            const k = 2 / Math.max(EPS, 1 + z);
            return [k * Math.cos(phi) * Math.sin(lambda), k * Math.sin(phi)];
        }
        case 'gnomonic': {
            if (z <= EPS) return null;
            return [
                Math.cos(phi) * Math.sin(lambda) / z,
                Math.sin(phi) / z,
            ];
        }
        case 'equirectangular':
        default:
            return [lambda, phi];
    }
}

function rawInvert(id, x, y) {
    switch (id) {
        case 'mercator':
            if (Math.abs(x) > PI + EPS || Math.abs(y) > mercatorY(MAX_MERCATOR_LAT) + EPS) return null;
            return [x, 2 * Math.atan(Math.exp(y)) - HALF_PI];
        case 'naturalEarth1':
            return invertNaturalEarth1Raw(x, y);
        case 'equalEarth':
            return invertEqualEarthRaw(x, y);
        case 'equirectangular':
            if (Math.abs(x) > PI + EPS || Math.abs(y) > HALF_PI + EPS) return null;
            return [x, y];
        case 'stereographic': {
            const rho = Math.hypot(x, y);
            if (rho < EPS) return [0, 0];
            const c = 2 * Math.atan(rho / 2);
            const sinc = Math.sin(c);
            return [Math.atan2(x * sinc, rho * Math.cos(c)), asin(y * sinc / rho)];
        }
        case 'gnomonic': {
            const rho = Math.hypot(x, y);
            if (rho < EPS) return [0, 0];
            const c = Math.atan(rho);
            const sinc = Math.sin(c);
            return [Math.atan2(x * sinc, rho * Math.cos(c)), asin(y * sinc / rho)];
        }
        default:
            return null;
    }
}

function validateWorldInvert(id, rawX, rawY, lambda, phi) {
    if (!Number.isFinite(lambda) || !Number.isFinite(phi)) return null;
    if (Math.abs(lambda) > PI + 0.02 || Math.abs(phi) > HALF_PI + 0.02) return null;
    const check = rawForward(id, lambda, phi, Math.cos(phi) * Math.cos(lambda));
    if (!check || Math.hypot(check[0] - rawX, check[1] - rawY) > 0.03) return null;
    return [lambda, clamp(phi, -HALF_PI, HALF_PI)];
}

export function projectMapPointFromRotated(point, lambdaOffset = 0, params = getMapProjectionParams()) {
    const raw = rawForward(params.id, point.lambda + lambdaOffset, point.phi, point.z);
    if (!raw) return null;
    return {
        x: raw[0] * params.scale,
        y: raw[1] * params.scale,
        lambda: point.lambda + lambdaOffset,
        phi: point.phi,
    };
}

export function projectMapPointFromXyz(x, y, z, lambdaOffset = 0, params = getMapProjectionParams()) {
    return projectMapPointFromRotated(rotateXyzToMap(x, y, z, params), lambdaOffset, params);
}

export function projectMapPointFromLonLat(lon, lat, lambdaOffset = 0, params = getMapProjectionParams()) {
    return projectMapPointFromRotated(rotateLonLatToMap(lon, lat, params), lambdaOffset, params);
}

export function projectMapTriangleFromXyz(vertices, params = getMapProjectionParams()) {
    const points = vertices.map(v => rotateXyzToMap(v[0], v[1], v[2], params));
    const batches = [];

    if (params.wrap) {
        const lons = points.map(p => p.lambda);
        if (Math.max(...lons) - Math.min(...lons) > PI) {
            batches.push(points.map(p => ({ ...p, lambda: p.lambda < 0 ? p.lambda + TAU : p.lambda })));
            batches.push(points.map(p => ({ ...p, lambda: p.lambda > 0 ? p.lambda - TAU : p.lambda })));
        } else {
            batches.push(points);
        }
    } else {
        batches.push(points);
    }

    const out = [];
    for (const batch of batches) {
        const projected = batch.map(p => projectMapPointFromRotated(p, 0, params));
        if (projected.every(Boolean)) out.push(projected);
    }
    return out;
}

function projectSegmentFromRotated(a, b, params) {
    const batches = [];
    if (params.wrap && Math.abs(a.lambda - b.lambda) > PI) {
        batches.push([
            { ...a, lambda: a.lambda < 0 ? a.lambda + TAU : a.lambda },
            { ...b, lambda: b.lambda < 0 ? b.lambda + TAU : b.lambda },
        ]);
        batches.push([
            { ...a, lambda: a.lambda > 0 ? a.lambda - TAU : a.lambda },
            { ...b, lambda: b.lambda > 0 ? b.lambda - TAU : b.lambda },
        ]);
    } else {
        batches.push([a, b]);
    }

    const out = [];
    for (const batch of batches) {
        const p0 = projectMapPointFromRotated(batch[0], 0, params);
        const p1 = projectMapPointFromRotated(batch[1], 0, params);
        if (p0 && p1) out.push([p0, p1]);
    }
    return out;
}

export function projectMapSegmentFromXyz(a, b, params = getMapProjectionParams()) {
    return projectSegmentFromRotated(
        rotateXyzToMap(a[0], a[1], a[2], params),
        rotateXyzToMap(b[0], b[1], b[2], params),
        params
    );
}

export function projectMapSegmentFromLonLat(lon0, lat0, lon1, lat1, params = getMapProjectionParams()) {
    return projectSegmentFromRotated(
        rotateLonLatToMap(lon0, lat0, params),
        rotateLonLatToMap(lon1, lat1, params),
        params
    );
}

export function createMapProjectionProjector(params = getMapProjectionParams()) {
    const orientation = orientationFromParams(params);
    return {
        id: params.id,
        scale: params.scale,
        wrap: params.wrap,
        centerLon: params.centerLon || 0,
        x0: orientation.x[0], x1: orientation.x[1], x2: orientation.x[2],
        y0: orientation.y[0], y1: orientation.y[1], y2: orientation.y[2],
        z0: orientation.z[0], z1: orientation.z[1], z2: orientation.z[2],
        triScratch: new Float64Array(15),
        segScratch: new Float64Array(10),
    };
}

function rotateXyzInto(projector, x, y, z, scratch, off) {
    const localX = x * projector.x0 + y * projector.x1 + z * projector.x2;
    const localY = x * projector.y0 + y * projector.y1 + z * projector.y2;
    const localZ = x * projector.z0 + y * projector.z1 + z * projector.z2;
    scratch[off] = localX;
    scratch[off + 1] = localY;
    scratch[off + 2] = localZ;
    scratch[off + 3] = Math.atan2(localX, localZ);
    scratch[off + 4] = asin(localY);
}

function rotateLonLatInto(projector, lon, lat, scratch, off) {
    const cosLat = Math.cos(lat);
    rotateXyzInto(
        projector,
        cosLat * Math.sin(lon),
        Math.sin(lat),
        cosLat * Math.cos(lon),
        scratch,
        off
    );
}

function projectRotatedInto(projector, lambda, phi, localX, localY, localZ, out, off, zOut) {
    const scale = projector.scale;
    switch (projector.id) {
        case 'mercator':
            out[off] = lambda * scale;
            out[off + 1] = mercatorY(clamp(phi, -MAX_MERCATOR_LAT, MAX_MERCATOR_LAT)) * scale;
            out[off + 2] = zOut;
            return true;
        case 'naturalEarth1': {
            const phi2 = phi * phi;
            const phi4 = phi2 * phi2;
            out[off] = lambda * (0.8707 - 0.131979 * phi2 + phi4 * (-0.013791 + phi4 * (0.003971 * phi2 - 0.001529 * phi4))) * scale;
            out[off + 1] = phi * (1.007226 + phi2 * (0.015085 + phi4 * (-0.044475 + 0.028874 * phi2 - 0.005916 * phi4))) * scale;
            out[off + 2] = zOut;
            return true;
        }
        case 'equalEarth': {
            const l = asin(EQ_M * Math.sin(phi));
            const l2 = l * l;
            const l6 = l2 * l2 * l2;
            out[off] = lambda * Math.cos(l) / (EQ_M * (EQ_A1 + 3 * EQ_A2 * l2 + l6 * (7 * EQ_A3 + 9 * EQ_A4 * l2))) * scale;
            out[off + 1] = l * (EQ_A1 + EQ_A2 * l2 + l6 * (EQ_A3 + EQ_A4 * l2)) * scale;
            out[off + 2] = zOut;
            return true;
        }
        case 'orthographic':
            if (localZ < -EPS) return false;
            out[off] = localX * scale;
            out[off + 1] = localY * scale;
            out[off + 2] = zOut;
            return true;
        case 'azimuthalEqualArea': {
            if (localZ <= AZIMUTHAL_EQUAL_AREA_MIN_Z) return false;
            const k = Math.sqrt(2 / Math.max(EPS, 1 + localZ));
            out[off] = k * localX * scale;
            out[off + 1] = k * localY * scale;
            out[off + 2] = zOut;
            return true;
        }
        case 'stereographic': {
            if (localZ <= -1 + EPS) return false;
            const k = 2 / Math.max(EPS, 1 + localZ);
            out[off] = k * localX * scale;
            out[off + 1] = k * localY * scale;
            out[off + 2] = zOut;
            return true;
        }
        case 'gnomonic':
            if (localZ <= EPS) return false;
            out[off] = localX / localZ * scale;
            out[off + 1] = localY / localZ * scale;
            out[off + 2] = zOut;
            return true;
        case 'equirectangular':
        default:
            out[off] = lambda * scale;
            out[off + 1] = phi * scale;
            out[off + 2] = zOut;
            return true;
    }
}

function projectedEdgeExceeds(out, a, b, maxEdge2) {
    const dx = out[a] - out[b];
    const dy = out[a + 1] - out[b + 1];
    return dx * dx + dy * dy > maxEdge2;
}

function azimuthalEqualAreaMaxEdge2(projector) {
    const maxEdge = AZIMUTHAL_EQUAL_AREA_MAX_RAW_EDGE * projector.scale;
    return maxEdge * maxEdge;
}

function writeProjectedTriangleBatch(projector, scratch, out, off, zOut, wrapMode) {
    let l0 = scratch[3], l1 = scratch[8], l2 = scratch[13];
    if (wrapMode === 1) {
        if (l0 < 0) l0 += TAU;
        if (l1 < 0) l1 += TAU;
        if (l2 < 0) l2 += TAU;
    } else if (wrapMode === -1) {
        if (l0 > 0) l0 -= TAU;
        if (l1 > 0) l1 -= TAU;
        if (l2 > 0) l2 -= TAU;
    }
    if (!projectRotatedInto(projector, l0, scratch[4], scratch[0], scratch[1], scratch[2], out, off, zOut)) return 0;
    if (!projectRotatedInto(projector, l1, scratch[9], scratch[5], scratch[6], scratch[7], out, off + 3, zOut)) return 0;
    if (!projectRotatedInto(projector, l2, scratch[14], scratch[10], scratch[11], scratch[12], out, off + 6, zOut)) return 0;
    if (projector.id === 'azimuthalEqualArea') {
        const maxEdge2 = azimuthalEqualAreaMaxEdge2(projector);
        if (
            projectedEdgeExceeds(out, off, off + 3, maxEdge2) ||
            projectedEdgeExceeds(out, off + 3, off + 6, maxEdge2) ||
            projectedEdgeExceeds(out, off + 6, off, maxEdge2)
        ) return 0;
    }
    return 1;
}

export function writeProjectedMapTriangleFromXyz(projector, sourceXyz, src, out, off, zOut = 0) {
    const scratch = projector.triScratch;
    rotateXyzInto(projector, sourceXyz[src], sourceXyz[src + 1], sourceXyz[src + 2], scratch, 0);
    rotateXyzInto(projector, sourceXyz[src + 3], sourceXyz[src + 4], sourceXyz[src + 5], scratch, 5);
    rotateXyzInto(projector, sourceXyz[src + 6], sourceXyz[src + 7], sourceXyz[src + 8], scratch, 10);

    if (projector.wrap) {
        const lon0 = scratch[3], lon1 = scratch[8], lon2 = scratch[13];
        if (Math.max(lon0, lon1, lon2) - Math.min(lon0, lon1, lon2) > PI) {
            let count = writeProjectedTriangleBatch(projector, scratch, out, off, zOut, 1);
            count += writeProjectedTriangleBatch(projector, scratch, out, off + count * 9, zOut, -1);
            return count;
        }
    }
    return writeProjectedTriangleBatch(projector, scratch, out, off, zOut, 0);
}

function writeProjectedSegmentBatch(projector, scratch, out, off, zOut, wrapMode) {
    let l0 = scratch[3], l1 = scratch[8];
    if (wrapMode === 1) {
        if (l0 < 0) l0 += TAU;
        if (l1 < 0) l1 += TAU;
    } else if (wrapMode === -1) {
        if (l0 > 0) l0 -= TAU;
        if (l1 > 0) l1 -= TAU;
    }
    if (!projectRotatedInto(projector, l0, scratch[4], scratch[0], scratch[1], scratch[2], out, off, zOut)) return 0;
    if (!projectRotatedInto(projector, l1, scratch[9], scratch[5], scratch[6], scratch[7], out, off + 3, zOut)) return 0;
    if (projector.id === 'azimuthalEqualArea' &&
        projectedEdgeExceeds(out, off, off + 3, azimuthalEqualAreaMaxEdge2(projector))) return 0;
    return 1;
}

function writeProjectedSegment(projector, scratch, out, off, zOut) {
    if (projector.wrap && Math.abs(scratch[3] - scratch[8]) > PI) {
        let count = writeProjectedSegmentBatch(projector, scratch, out, off, zOut, 1);
        count += writeProjectedSegmentBatch(projector, scratch, out, off + count * 6, zOut, -1);
        return count;
    }
    return writeProjectedSegmentBatch(projector, scratch, out, off, zOut, 0);
}

export function writeProjectedMapSegmentFromXyz(projector, sourceSegments, src, out, off, zOut = 0) {
    const scratch = projector.segScratch;
    rotateXyzInto(projector, sourceSegments[src], sourceSegments[src + 1], sourceSegments[src + 2], scratch, 0);
    rotateXyzInto(projector, sourceSegments[src + 3], sourceSegments[src + 4], sourceSegments[src + 5], scratch, 5);
    return writeProjectedSegment(projector, scratch, out, off, zOut);
}

export function writeProjectedMapSegmentFromLonLat(projector, sourceSegments, src, out, off, zOut = 0) {
    const scratch = projector.segScratch;
    rotateLonLatInto(projector, sourceSegments[src], sourceSegments[src + 1], scratch, 0);
    rotateLonLatInto(projector, sourceSegments[src + 2], sourceSegments[src + 3], scratch, 5);
    return writeProjectedSegment(projector, scratch, out, off, zOut);
}

export function mapPointToXyz(x, y, params = getMapProjectionParams()) {
    const rawX = x / params.scale;
    const rawY = y / params.scale;

    if (params.id === 'orthographic') {
        const r2 = rawX * rawX + rawY * rawY;
        if (r2 > 1 + EPS) return null;
        return localToWorldVector(rawX, rawY, Math.sqrt(Math.max(0, 1 - r2)), params);
    }

    if (params.id === 'azimuthalEqualArea') {
        const rho = Math.hypot(rawX, rawY);
        if (rho > AZIMUTHAL_EQUAL_AREA_MAX_R + EPS) return null;
        if (rho < EPS) return localToWorldVector(0, 0, 1, params);
        const c = 2 * Math.asin(clamp(rho / 2, -1, 1));
        const k = Math.sin(c) / rho;
        return localToWorldVector(rawX * k, rawY * k, Math.cos(c), params);
    }

    const inverted = rawInvert(params.id, rawX, rawY);
    if (!inverted) return null;
    const valid = validateWorldInvert(params.id, rawX, rawY, inverted[0], inverted[1]);
    if (!valid) return null;
    const [lambda, phi] = valid;
    const cosPhi = Math.cos(phi);
    return localToWorldVector(cosPhi * Math.sin(lambda), Math.sin(phi), cosPhi * Math.cos(lambda), params);
}

export function projectMapDirectionFromXyz(x, y, z, dx, dy, dz, step = 0.035, params = getMapProjectionParams()) {
    const base = projectMapPointFromXyz(x, y, z, 0, params);
    if (!base) return null;

    let tx = x + dx * step;
    let ty = y + dy * step;
    let tz = z + dz * step;
    const len = Math.hypot(tx, ty, tz) || 1;
    tx /= len; ty /= len; tz /= len;

    const tip = projectMapPointFromXyz(tx, ty, tz, 0, params);
    if (!tip) return null;

    const vx = tip.x - base.x;
    const vy = tip.y - base.y;
    if (!Number.isFinite(vx) || !Number.isFinite(vy) || Math.hypot(vx, vy) > 0.5) return null;
    return { x: base.x, y: base.y, dx: vx, dy: vy };
}
