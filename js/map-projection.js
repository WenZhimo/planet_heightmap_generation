import { state } from './state.js';

const PI = Math.PI;
const HALF_PI = PI / 2;
const TAU = PI * 2;
const DEG = PI / 180;
const EPS = 1e-6;
const MAX_MERCATOR_LAT = 85 * DEG;

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

    return {
        x: localX,
        y: localY,
        z: localZ,
        lambda: Math.atan2(localX, localZ),
        phi: asin(localY),
    };
}

export function rotateXyzToMap(x, y, z, params = getMapProjectionParams()) {
    const [lon, lat] = vectorToLonLat(x, y, z);
    return rotateLonLatToMap(lon, lat, params);
}

function localToWorldVector(localX, localY, localZ, params) {
    const sinCenter = Math.sin(params.centerLat);
    const cosCenter = Math.cos(params.centerLat);
    const sinLat = sinCenter * localZ + cosCenter * localY;
    const lat = asin(sinLat);
    const h = cosCenter * localZ - sinCenter * localY;
    const lon = wrapRadians(params.centerLon + Math.atan2(localX, h));
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
            if (z <= -1 + EPS) return null;
            const k = Math.sqrt(2 / Math.max(EPS, 1 + z));
            return [k * Math.cos(phi) * Math.sin(lambda), k * Math.sin(phi)];
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
        if (rho > 2 + EPS) return null;
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
