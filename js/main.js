// Entry point — wires UI controls, animation loop, and generation flow.

import * as THREE from 'three';
import { renderer, scene, camera, ctrl, waterMesh, atmosMesh, starsMesh,
         mapCamera, updateMapCameraFrustum, mapCtrl, canvas,
         tickZoom, tickMapZoom, tickFreeCamera, setFreeCameraControls, recenterGlobeCamera,
         resetMapCameraView, setMapCameraZoom } from './scene.js';
import { state } from './state.js';
import { generate, reapplyViaWorker, computeClimateViaWorker, editRecomputeViaWorker } from './generate.js';
import { encodePlanetCode, decodePlanetCode } from './planet-code.js';
import { buildMesh, updateMeshColors, updateSuperPlateBorders, buildMapMesh, updateMapProjectionMeshes, setMapProjectionPreviewActive, rebuildGrids, exportMap, exportWorldBundle, buildWindArrows, buildOceanCurrentArrows, updateKoppenHoverHighlight, updateMapKoppenHoverHighlight, updatePendingHighlight, updateMapPendingHighlight } from './planet-mesh.js';
import { setupEditMode } from './edit-mode.js';
import { detailFromSlider, sliderFromDetail } from './detail-scale.js';
import { KOPPEN_CLASSES } from './koppen.js';
import { elevationToColor } from './color-map.js';
import { formatLatLabel, formatLonLabel, getMapProjectionLabel, getMapProjectionParams,
         rotateMapProjectionParamsByDrag } from './map-projection.js';

// Slider value displays + stale tracking
const sliderIds = ['sN','sP','sCn','sJ','sNs','sCsv','sLc'];
const PLATE_SLIDERS = ['sP', 'sCn', 'sCsv', 'sLc'];
const PLANET_SEED_MAX = 16777216;
let lastGenValues = {};
let pendingPlanetSeed = randomPlanetSeed();
let startupGenerationInProgress = false;

function randomPlanetSeed() {
    const values = new Uint32Array(1);
    if (window.crypto && window.crypto.getRandomValues) {
        window.crypto.getRandomValues(values);
        return values[0] % PLANET_SEED_MAX;
    }
    return Math.floor(Math.random() * PLANET_SEED_MAX);
}

function randomPlanetSeedExcept(seedToAvoid) {
    let seed = randomPlanetSeed();
    if (!Number.isFinite(seedToAvoid)) return seed;
    for (let i = 0; i < 8 && seed === seedToAvoid; i++) seed = randomPlanetSeed();
    return seed === seedToAvoid ? (seed + 1) % PLANET_SEED_MAX : seed;
}

function snapshotSliders() {
    for (const id of sliderIds) lastGenValues[id] = document.getElementById(id).value;
}

function plateSettingsChanged() {
    return !!state.curData && PLATE_SLIDERS.some(id => document.getElementById(id).value !== lastGenValues[id]);
}

function checkStale() {
    const btn = document.getElementById('generate');
    if (btn.classList.contains('generating')) return;
    if (!state.curData) {
        btn.classList.remove('stale', 'regen');
        btn.textContent = '生成新世界';
        return;
    }
    const detailSliders = ['sN', 'sJ', 'sNs'];
    const plateChanged = plateSettingsChanged();
    const detailChanged = detailSliders.some(id => document.getElementById(id).value !== lastGenValues[id]);
    btn.classList.remove('stale', 'regen');
    if (plateChanged) {
        btn.classList.add('regen');
        btn.textContent = '重新生成';
    } else if (detailChanged) {
        btn.classList.add('stale');
        btn.textContent = '重建';
    } else {
        btn.textContent = '生成新世界';
    }
}

// Reapply smoothing + erosion without full rebuild (via worker)
function reapplyPostProcessing() {
    const d = state.curData;
    if (!d || !d.prePostElev) return;

    const skipClimate = shouldSkipClimate();
    reapplyViaWorker(() => {
        reapplyBtn.classList.remove('spinning');
        updatePlanetCode(false);
        // If climate invalidated and viewing a climate layer, switch to Terrain
        if (skipClimate && CLIMATE_LAYERS.has(state.debugLayer)) {
            state.debugLayer = '';
            if (debugLayerEl) debugLayerEl.value = '';
            syncTabsToLayer('');
            updateMeshColors();
            updateLegend('');
        }
    }, skipClimate);
}

const reapplyBtn = document.getElementById('reapplyBtn');

function markReapplyPending() {
    reapplyBtn.disabled = false;
    reapplyBtn.classList.add('ready');
}

function clearReapplyPending() {
    reapplyBtn.disabled = true;
    reapplyBtn.classList.remove('ready');
}

reapplyBtn.addEventListener('click', () => {
    if (reapplyBtn.disabled) return;
    clearReapplyPending();
    reapplyBtn.classList.add('spinning');
    reapplyPostProcessing();
});

// Auto Climate checkbox — default OFF above threshold
const AUTO_CLIMATE_THRESHOLD = 300000;

// Detail slider warning update (lower thresholds on touch devices)
const WARN_ORANGE = state.isTouchDevice ? 200000 : 640000;
const WARN_RED    = state.isTouchDevice ? 500000 : 1280000;

function updateDetailWarning(detail) {
    const cg = document.getElementById('sN').closest('.cg');
    const warn = document.getElementById('detailWarn');
    cg.classList.remove('detail-orange', 'detail-red');
    warn.className = 'detail-warn';
    if (detail > WARN_RED) {
        cg.classList.add('detail-red');
        warn.classList.add('red');
        warn.textContent = '\u26A0 极高细节 - 生成可能较慢且不稳定';
    } else if (detail > WARN_ORANGE) {
        cg.classList.add('detail-orange');
        warn.classList.add('orange');
        warn.textContent = '\u26A0 高细节 - 生成可能较慢且不稳定';
    } else {
        warn.textContent = '';
    }
}

// Slider thumb tooltip — floating value bubble near the thumb during drag
function initSliderTooltip(slider) {
    const cg = slider.closest('.cg');
    if (!cg) return;
    cg.style.position = 'relative';
    const tip = document.createElement('div');
    tip.className = 'slider-tooltip';
    cg.appendChild(tip);

    function positionTip() {
        const pct = (+slider.value - +slider.min) / (+slider.max - +slider.min);
        const thumbOffset = pct * slider.offsetWidth;
        tip.style.left = thumbOffset + 'px';
    }

    slider.addEventListener('pointerdown', () => {
        tip.textContent = document.getElementById(slider.id.replace('s', 'v')).textContent;
        positionTip();
        tip.classList.add('visible');
    });
    slider.addEventListener('input', () => {
        tip.textContent = document.getElementById(slider.id.replace('s', 'v')).textContent;
        positionTip();
    });
    const hide = () => tip.classList.remove('visible');
    slider.addEventListener('pointerup', hide);
    slider.addEventListener('pointercancel', hide);
}

for (const [s,v] of [['sN','vN'],['sP','vP'],['sCn','vCn'],['sJ','vJ'],['sNs','vNs'],['sCsv','vCsv'],['sLc','vLc'],['sTw','vTw'],['sS','vS'],['sGl','vGl'],['sHEr','vHEr'],['sTEr','vTEr'],['sRs','vRs'],['sTmp','vTmp'],['sPrc','vPrc']]) {
    const slider = document.getElementById(s);
    initSliderTooltip(slider);
    slider.addEventListener('input', e => {
        if (s === 'sN') {
            const detail = detailFromSlider(+e.target.value);
            document.getElementById(v).textContent = detail.toLocaleString();
            updateDetailWarning(detail);
        } else if (s === 'sTmp') {
            const val = +e.target.value;
            document.getElementById(v).textContent = (val > 0 ? '+' : val === 0 ? '\u00b1' : '') + val + '\u00b0C';
        } else if (s === 'sPrc') {
            const val = +e.target.value;
            const pct = Math.round(val * 50);
            document.getElementById(v).textContent = (pct > 0 ? '+' : pct === 0 ? '\u00b1' : '') + pct + '%';
        } else if (s === 'sLc') {
            document.getElementById(v).textContent = Math.round(+e.target.value * 100) + '%';
        } else {
            document.getElementById(v).textContent = e.target.value;
        }
        updatePlanetCode(false);
        if (s === 'sTw' || s === 'sS' || s === 'sGl' || s === 'sHEr' || s === 'sTEr' || s === 'sRs') {
            markReapplyPending();
        } else if (s === 'sTmp' || s === 'sPrc') {
            // Display-only update during drag; actual recompute on change (release)
        } else {
            checkStale();
        }
    });
    // Climate sliders: recompute only on release (change), not every drag tick
    if (s === 'sTmp' || s === 'sPrc') {
        slider.addEventListener('change', () => {
            if (!state.curData) return;
            updatePlanetCode(false);
            showBuildOverlay();
            computeClimateViaWorker(onProgress, () => {
                hideBuildOverlay();
                updateMeshColors();
                updateLegend(state.debugLayer);
            });
        });
    }
}

const shapeSeedInput = document.getElementById('shapeSeed');
const shapeSeedRandomBtn = document.getElementById('shapeSeedRandom');
const shapeSeedApplyBtn = document.getElementById('shapeSeedApply');

function hashShapeSeed(seedText) {
    let h = 2166136261;
    for (let i = 0; i < seedText.length; i++) {
        h ^= seedText.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function makeShapeSeedRng(seedText) {
    let t = hashShapeSeed(seedText) || 0x6d2b79f5;
    return () => {
        t = (t + 0x6d2b79f5) >>> 0;
        let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
        return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
}

function seededSliderValue(rng, min, max, step) {
    const slots = Math.round((max - min) / step);
    const raw = min + Math.floor(rng() * (slots + 1)) * step;
    const decimals = step < 1 ? String(step).split('.')[1].length : 0;
    return decimals > 0 ? raw.toFixed(decimals) : String(raw);
}

function setSliderFromSeed(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
}

function makeRandomShapeSeed() {
    return 'shape-' + randomPlanetSeed().toString(36).padStart(5, '0');
}

function applyShapeSeed(seedText) {
    const seed = (seedText || '').trim() || makeRandomShapeSeed();
    if (shapeSeedInput) shapeSeedInput.value = seed;
    const rng = makeShapeSeedRng(seed);
    const values = {
        sJ: seededSliderValue(rng, 0.45, 0.95, 0.05),
        sP: seededSliderValue(rng, 16, 120, 1),
        sCn: seededSliderValue(rng, 1, 10, 1),
        sNs: seededSliderValue(rng, 0.12, 0.50, 0.01),
        sCsv: seededSliderValue(rng, 0, 1, 0.05),
        sLc: seededSliderValue(rng, 0.15, 0.65, 0.01),
    };
    for (const [id, value] of Object.entries(values)) setSliderFromSeed(id, value);
    updatePlanetCode(true);
}

if (shapeSeedRandomBtn && shapeSeedInput) {
    shapeSeedRandomBtn.addEventListener('click', () => {
        shapeSeedInput.value = makeRandomShapeSeed();
        applyShapeSeed(shapeSeedInput.value);
    });
}

if (shapeSeedApplyBtn && shapeSeedInput) {
    shapeSeedApplyBtn.addEventListener('click', () => applyShapeSeed(shapeSeedInput.value));
    shapeSeedInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') applyShapeSeed(shapeSeedInput.value);
    });
}

// Force range input re-render when <details> sections are opened.
// Browsers may not update the visual thumb position for sliders that were
// hidden (inside a closed <details>) when their value was set via JS.
document.querySelectorAll('details.section').forEach(det => {
    det.addEventListener('toggle', () => {
        if (!det.open) return;
        det.querySelectorAll('input[type="range"]').forEach(s => {
            const v = s.value; s.value = ''; s.value = v;
        });
    });
});

/** Returns true if climate should be skipped (detail above threshold). */
function shouldSkipClimate() {
    return detailFromSlider(+document.getElementById('sN').value) > AUTO_CLIMATE_THRESHOLD;
}

// Climate layer keys — layers that require climate data
const CLIMATE_LAYERS = new Set([
    'pressureSummer', 'pressureWinter',
    'windSpeedSummer', 'windSpeedWinter',
    'oceanCurrentSummer', 'oceanCurrentWinter',
    'precipSummer', 'precipWinter',
    'rainShadowSummer', 'rainShadowWinter',
    'tempSummer', 'tempWinter',
    'koppen', 'biome', 'continentality', 'tempContinentality'
]);

// Map tabs → tab-layer mapping
const mapTabs = document.getElementById('mapTabs');
const vizLegend = document.getElementById('vizLegend');
const debugLayerEl = document.getElementById('debugLayer');

function switchVisualization(layer) {
    if (!state.curData) {
        state.debugLayer = layer;
        updateLegend(layer);
        updateViewHint();
        return;
    }
    if (CLIMATE_LAYERS.has(layer) && !state.climateComputed) {
        // Need to compute climate first
        showBuildOverlay();
        computeClimateViaWorker(onProgress, () => {
            hideBuildOverlay();
            applyLayer(layer);
        });
        return;
    }
    applyLayer(layer);
}

function applyLayer(layer) {
    state.debugLayer = layer;
    state.hoveredKoppen = -1;
    updateMeshColors();
    // Show/hide wind/ocean arrows
    const isWindLayer = layer === 'pressureSummer' || layer === 'pressureWinter' ||
                        layer === 'windSpeedSummer' || layer === 'windSpeedWinter';
    const isOceanLayer = layer === 'oceanCurrentSummer' || layer === 'oceanCurrentWinter';
    if (isOceanLayer) {
        const season = layer.includes('Winter') ? 'winter' : 'summer';
        buildWindArrows(null);
        buildOceanCurrentArrows(season);
    } else if (isWindLayer) {
        const season = layer.includes('Winter') ? 'winter' : 'summer';
        buildOceanCurrentArrows(null);
        buildWindArrows(season);
    } else {
        buildWindArrows(null);
        buildOceanCurrentArrows(null);
    }
    updateLegend(layer);
}

function syncTabsToLayer(layer) {
    mapTabs.querySelectorAll('.map-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.layer === layer);
    });
    // Sync mobile view switcher (only for main views it knows about)
    const mvs = document.getElementById('mobileViewSwitch');
    if (mvs && [...mvs.options].some(o => o.value === layer)) {
        mvs.value = layer;
    }
}

mapTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.map-tab');
    if (!tab) return;
    const layer = tab.dataset.layer;
    // Update active tab
    mapTabs.querySelectorAll('.map-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    // Sync debug dropdown + mobile switcher
    if (debugLayerEl) debugLayerEl.value = layer;
    mobileViewSwitch.value = layer;
    switchVisualization(layer);
});

// Mobile view switcher
const mobileViewSwitch = document.getElementById('mobileViewSwitch');
mobileViewSwitch.addEventListener('change', (e) => {
    const layer = e.target.value;
    syncTabsToLayer(layer);
    if (debugLayerEl) debugLayerEl.value = layer;
    switchVisualization(layer);
});

// Koppen climate zone descriptions for hover tooltips
const KOPPEN_DESCRIPTIONS = {
    Af:  '热带雨林气候 - 终年炎热湿润。典型区域：亚马逊盆地、刚果盆地、东南亚。',
    Am:  '热带季风气候 - 短暂旱季后有强季风降雨。典型区域：印度南部、西非、澳大利亚北部。',
    Aw:  '热带稀树草原气候 - 干湿季分明。典型区域：撒哈拉以南非洲、巴西塞拉多、澳大利亚北部。',
    BWh: '热带沙漠气候 - 极端干燥且夏季酷热。典型区域：撒哈拉、阿拉伯沙漠、索诺兰沙漠。',
    BWk: '冷沙漠气候 - 干旱且冬季寒冷。典型区域：戈壁、巴塔哥尼亚草原、大盆地。',
    BSh: '热带草原气候 - 半干旱草原，夏季炎热。典型区域：萨赫勒、澳大利亚内陆、墨西哥北部。',
    BSk: '冷草原气候 - 半干旱且冬季寒冷。典型区域：中亚草原、蒙大拿、安纳托利亚高原。',
    Cfa: '湿润亚热带气候 - 夏季炎热潮湿，冬季温和。典型区域：美国东南部、中国东部、布宜诺斯艾利斯。',
    Cfb: '海洋性气候 - 全年温和，夏季凉爽，降雨频繁。典型区域：西欧、新西兰、太平洋西北部。',
    Cfc: '副极地海洋性气候 - 全年凉爽，夏季短。典型区域：冰岛、智利南部、法罗群岛。',
    Csa: '夏热地中海气候 - 夏季干热，冬季温和多雨。典型区域：南加州、希腊、土耳其海岸。',
    Csb: '夏暖地中海气候 - 夏季干暖，冬季温和多雨。典型区域：旧金山、波尔图、开普敦。',
    Csc: '夏凉地中海气候 - 夏季凉爽干燥，冬季温和多雨。较罕见，多见于高海拔地中海海岸。',
    Cwa: '季风型湿润亚热带气候 - 温暖且冬季干燥。典型区域：香港、印度北部、巴西东南高地。',
    Cwb: '亚热带高原气候 - 温和且冬季干燥。典型区域：墨西哥城、波哥大、埃塞俄比亚高原。',
    Cwc: '冷凉亚热带高原气候 - 凉爽且冬季干燥。较罕见，多见于热带高山。',
    Dfa: '夏热大陆性气候 - 夏季炎热，冬季寒冷多雪。典型区域：芝加哥、基辅、北京。',
    Dfb: '夏暖大陆性气候 - 夏季温暖，冬季寒冷。典型区域：莫斯科、斯堪的纳维亚南部、新英格兰。',
    Dfc: '亚寒带气候 - 冬季漫长寒冷，夏季短暂凉爽。典型区域：西伯利亚、加拿大北部、阿拉斯加内陆。',
    Dfd: '极寒亚寒带气候 - 地球上最严寒的冬季。典型区域：雅库茨克、维尔霍扬斯克。',
    Dsa: '夏热大陆性干夏气候 - 夏季干热，冬季寒冷。典型区域：土耳其东部、伊朗部分地区。',
    Dsb: '夏暖大陆性干夏气候 - 夏季干暖，冬季寒冷。典型区域：美国西部高地部分地区。',
    Dsc: '亚寒带干夏气候 - 夏季凉爽干燥，冬季严寒。较罕见，多见于高海拔内陆。',
    Dsd: '极寒亚寒带干夏气候 - 极罕见，兼具严寒和干夏。',
    Dwa: '夏热大陆性季风气候 - 夏季湿热，冬季干冷。典型区域：中国北方、朝鲜半岛。',
    Dwb: '夏暖大陆性季风气候 - 夏季温暖多雨，冬季干冷。典型区域：中国东北部分地区。',
    Dwc: '亚寒带季风气候 - 夏季短暂多雨，冬季漫长严寒干燥。典型区域：东西伯利亚、中国东北远端。',
    Dwd: '极寒亚寒带季风气候 - 极寒且冬季最干。典型区域：东西伯利亚内陆。',
    ET:  '苔原气候 - 多年冻土，只有最暖月高于 0 C。典型区域：北极海岸、高山高原。',
    EF:  '冰原气候 - 永久冰盖，全年不高于 0 C。典型区域：南极内陆、格陵兰冰盖。',
};

// Legend rendering
function updateLegend(layer) {
    if (!vizLegend) return;

    if (layer === '' || !layer) {
        // Terrain legend
        const stops = [
            { e: -0.50, label: '' },
            { e: -0.25, label: '' },
            { e: -0.05, label: '' },
            { e: 0.00, label: '' },
            { e: 0.03, label: '' },
            { e: 0.15, label: '' },
            { e: 0.35, label: '' },
            { e: 0.55, label: '' },
            { e: 0.80, label: '' }
        ];
        const colors = stops.map(s => {
            const [r, g, b] = elevationToColor(s.e);
            return `rgb(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)})`;
        });
        const pcts = stops.map((_, i) => Math.round(i / (stops.length - 1) * 100));
        const gradStr = colors.map((c, i) => `${c} ${pcts[i]}%`).join(', ');
        vizLegend.innerHTML = `<div class="legend-gradient" style="background:linear-gradient(to right,${gradStr})"></div>` +
            `<div class="legend-labels"><span>深海</span><span>海平面</span><span>峰顶</span></div>`;
    } else if (layer === 'koppen') {
        // Koppen legend — Wikipedia link + swatches with hover tooltips
        let html = '<div class="legend-koppen-header"><a href="https://en.wikipedia.org/wiki/K%C3%B6ppen_climate_classification" target="_blank" rel="noopener">柯本气候分类</a></div>';
        html += '<div class="legend-koppen">';
        for (let i = 1; i < KOPPEN_CLASSES.length; i++) {
            const k = KOPPEN_CLASSES[i];
            const [r, g, b] = k.color;
            const hex = `rgb(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)})`;
            const desc = KOPPEN_DESCRIPTIONS[k.code] || k.name;
            html += `<div class="legend-koppen-item" data-code="${k.code}"><span class="legend-koppen-swatch" style="background:${hex}"></span>${k.code}</div>`;
        }
        html += '<div class="legend-koppen-tooltip" id="koppenTip"></div>';
        html += '</div>';
        vizLegend.innerHTML = html;
        // Wire hover tooltips with dynamic positioning
        const tipEl = document.getElementById('koppenTip');
        const container = vizLegend.querySelector('.legend-koppen');
        vizLegend.querySelectorAll('.legend-koppen-item').forEach(item => {
            item.addEventListener('mouseenter', () => {
                const code = item.dataset.code;
                const desc = KOPPEN_DESCRIPTIONS[code] || '';
                tipEl.textContent = desc;
                tipEl.classList.add('visible');
                // Position above the hovered item, clamped within the container
                const itemRect = item.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();
                const tipWidth = 240;
                let left = itemRect.left - containerRect.left + itemRect.width / 2 - tipWidth / 2;
                left = Math.max(0, Math.min(left, containerRect.width - tipWidth));
                tipEl.style.left = left + 'px';
                tipEl.style.bottom = (containerRect.bottom - itemRect.top + 6) + 'px';
                // Highlight matching cells on the mesh
                const classId = KOPPEN_CLASSES.findIndex(c => c.code === code);
                if (classId >= 0) {
                    state.hoveredKoppen = classId;
                    updateKoppenHoverHighlight();
                    updateMapKoppenHoverHighlight();
                }
            });
            item.addEventListener('mouseleave', () => {
                tipEl.classList.remove('visible');
                state.hoveredKoppen = -1;
                updateKoppenHoverHighlight();
                updateMapKoppenHoverHighlight();
            });
        });
    } else if (layer === 'biome') {
        // Satellite biome legend — gradient bar of key biome colors
        const biomeStops = [
            { color: [0.82,0.72,0.50], label: '沙漠' },
            { color: [0.72,0.62,0.30], label: '草原' },
            { color: [0.42,0.50,0.18], label: '稀树草原' },
            { color: [0.12,0.38,0.10], label: '森林' },
            { color: [0.06,0.22,0.08], label: '针叶林' },
            { color: [0.35,0.32,0.22], label: '苔原' },
            { color: [0.78,0.80,0.84], label: '冰原' },
        ];
        const biomeColors = biomeStops.map(s => {
            const [r, g, b] = s.color;
            return `rgb(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)})`;
        });
        const biomePcts = biomeStops.map((_, i) => Math.round(i / (biomeStops.length - 1) * 100));
        const biomeGrad = biomeColors.map((c, i) => `${c} ${biomePcts[i]}%`).join(', ');
        vizLegend.innerHTML = `<div class="legend-gradient" style="background:linear-gradient(to right,${biomeGrad})"></div>` +
            `<div class="legend-labels"><span>${biomeStops[0].label}</span><span>${biomeStops[3].label}</span><span>${biomeStops[6].label}</span></div>`;
    } else if (layer === 'rainShadowSummer' || layer === 'rainShadowWinter') {
        // Rain shadow diverging legend: leeward shadow ↔ neutral ↔ windward boost
        vizLegend.innerHTML = `<div class="legend-gradient" style="background:linear-gradient(to right,rgb(230,51,33) 0%,rgb(140,140,148) 50%,rgb(38,102,243) 100%)"></div>` +
            `<div class="legend-labels"><span>雨影</span><span>中性</span><span>迎风</span></div>`;
    } else if (layer === 'landheightmap') {
        vizLegend.innerHTML = `<div class="legend-gradient" style="background:linear-gradient(to right,#000 0%,#fff 100%)"></div>` +
            `<div class="legend-labels"><span>海洋 / 海平面</span><span>峰顶</span></div>`;
    } else {
        vizLegend.innerHTML = '';
    }
}

// Build overlay — unified loading / generation overlay
const buildOverlay  = document.getElementById('buildOverlay');
const buildBarFill  = document.getElementById('buildBarFill');
const buildBarLabel = document.getElementById('buildBarLabel');
const initialPreview = document.getElementById('initialPreview');
let overlayActive = false;
let buildOverlayHideTimer = 0;

function onProgress(pct, label) {
    if (!overlayActive) return;
    if (buildBarFill)  buildBarFill.style.transform = 'scaleX(' + (pct / 100) + ')';
    if (buildBarLabel) buildBarLabel.textContent = label;
}

function showBuildOverlay() {
    if (!buildBarFill || !buildOverlay) return;
    if (buildOverlayHideTimer) {
        clearTimeout(buildOverlayHideTimer);
        buildOverlayHideTimer = 0;
    }
    // Snap bar to 0 instantly — disable transition, reset transform, force reflow
    buildBarFill.style.transition = 'none';
    buildBarFill.style.transform = 'scaleX(0)';
    buildBarLabel.textContent = '';
    buildBarFill.offsetWidth; // force reflow
    buildBarFill.style.transition = '';
    overlayActive = true;
    buildOverlay.classList.remove('hidden');
}

function hideBuildOverlay() {
    if (buildOverlayHideTimer) clearTimeout(buildOverlayHideTimer);
    buildOverlayHideTimer = setTimeout(() => {
        buildOverlayHideTimer = 0;
        overlayActive = false;
        if (buildOverlay) {
            buildOverlay.classList.add('hidden');
            // After first generation, switch from opaque to semi-transparent
            buildOverlay.classList.remove('initial');
        }
    }, 500);
}

function hideInitialPreview() {
    if (initialPreview) initialPreview.classList.add('hidden');
    if (canvas) canvas.classList.remove('empty');
}

function showInitialPreview() {
    if (initialPreview) initialPreview.classList.remove('hidden');
    if (canvas) canvas.classList.add('empty');
}

// Generate button
const genBtn = document.getElementById('generate');
genBtn.addEventListener('click', () => {
    clearReapplyPending();
    buildWindArrows(null); // dispose previous wind arrows
    buildOceanCurrentArrows(null); // dispose previous ocean arrows
    hideInitialPreview();
    showBuildOverlay();
    // Collapse bottom sheet on mobile so user can see the planet build
    const ui = document.getElementById('ui');
    if (window.innerWidth <= 768 && ui) ui.classList.add('collapsed');
    // Rebuild: reuse seed + plate edits so only resolution/params change.
    // If plate-affecting sliders (Plates, Continents, Continent Size Variety, Land Coverage) changed,
    // force a fresh generation — the coarse plate grid is fully determined by seed + P + Cn + Csv + Lc.
    const plateChanged = plateSettingsChanged();
    const isRebuild = genBtn.classList.contains('stale') && state.curData && !plateChanged;
    const seed = isRebuild
        ? state.curData.seed
        : randomPlanetSeedExcept(state.curData ? state.curData.seed : pendingPlanetSeed);
    pendingPlanetSeed = seed;
    const toggles = isRebuild ? getToggledIndices() : [];
    updatePlanetCode(false);
    generate(seed, toggles, onProgress, shouldSkipClimate());
});
genBtn.addEventListener('generate-done', snapshotSliders);
genBtn.addEventListener('generate-done', hideBuildOverlay);
genBtn.addEventListener('generate-done', () => {
    startupGenerationInProgress = false;
    if (state.curData) pendingPlanetSeed = state.curData.seed;
    hideInitialPreview();
    syncWorldReadyControls();
    updateViewHint();
});
genBtn.addEventListener('generate-done', () => {
    const infoEl = document.getElementById('info');
    if (!infoEl.dataset.nudged) {
        infoEl.dataset.nudged = '1';
        infoEl.classList.add('nudge');
        infoEl.addEventListener('animationend', () => infoEl.classList.remove('nudge'), { once: true });
    }
}, { once: true });

// Planet code — display after generation, copy, load, URL hash
const seedInput = document.getElementById('seedCode');
const copyBtn   = document.getElementById('copyBtn');
const loadBtn   = document.getElementById('loadBtn');
let currentCode = ''; // the code for the currently loaded planet
let planetCodeRefreshSuppressed = false;

function updateLoadBtn() {
    const val = seedInput.value.trim().toLowerCase();
    const ready = val.length > 0 && val !== currentCode;
    loadBtn.classList.toggle('ready', ready);
}

/** Get sorted array of toggled plate indices by diffing current vs original plateIsOcean. */
function getToggledIndices() {
    const d = state.curData;
    if (!d || !d.originalPlateIsOcean) return [];
    const indices = [];
    const seeds = Array.from(d.plateSeeds);
    for (let i = 0; i < seeds.length; i++) {
        const r = seeds[i];
        if (d.originalPlateIsOcean.has(r) !== d.plateIsOcean.has(r)) {
            indices.push(i);
        }
    }
    return indices;
}

function getEncodedToggledIndices() {
    return plateSettingsChanged() ? [] : getToggledIndices();
}

function getPlanetCodeSeed() {
    if (!state.curData) return pendingPlanetSeed;
    return pendingPlanetSeed !== state.curData.seed ? pendingPlanetSeed : state.curData.seed;
}

/** Encode current planet state and update the seed input + URL hash. */
function updatePlanetCode(flash) {
    if (planetCodeRefreshSuppressed) return;
    const code = encodePlanetCode(
        getPlanetCodeSeed(),
        detailFromSlider(+document.getElementById('sN').value),
        +document.getElementById('sJ').value,
        +document.getElementById('sP').value,
        +document.getElementById('sCn').value,
        +document.getElementById('sNs').value,
        +document.getElementById('sTw').value,
        +document.getElementById('sS').value,
        +document.getElementById('sGl').value,
        +document.getElementById('sHEr').value,
        +document.getElementById('sTEr').value,
        +document.getElementById('sRs').value,
        +document.getElementById('sCsv').value,
        +document.getElementById('sTmp').value,
        +document.getElementById('sPrc').value,
        +document.getElementById('sLc').value,
        getEncodedToggledIndices()
    );
    currentCode = code;
    seedInput.value = code;
    updateLoadBtn();
    if (state.curData) history.replaceState(null, '', '#' + code);
    if (flash) {
        seedInput.classList.add('flash');
        seedInput.addEventListener('animationend', () => seedInput.classList.remove('flash'), { once: true });
    }
}

genBtn.addEventListener('generate-done', () => updatePlanetCode(false));
genBtn.addEventListener('generate-done', () => {
    // If climate not computed and current view is a climate layer, switch to Terrain
    if (!state.climateComputed && CLIMATE_LAYERS.has(state.debugLayer)) {
        state.debugLayer = '';
        if (debugLayerEl) debugLayerEl.value = '';
        syncTabsToLayer('');
        updateMeshColors();
    }
    syncTabsToLayer(state.debugLayer);
    if (debugLayerEl) debugLayerEl.value = state.debugLayer;
    updateLegend(state.debugLayer);

    // Rebuild wind/ocean arrows if a relevant debug layer is active
    const v = state.debugLayer;
    const isWindLayer = v === 'pressureSummer' || v === 'pressureWinter' ||
                        v === 'windSpeedSummer' || v === 'windSpeedWinter';
    const isOceanLayer = v === 'oceanCurrentSummer' || v === 'oceanCurrentWinter';
    if (isWindLayer) {
        buildWindArrows(v.includes('Winter') ? 'winter' : 'summer');
    } else if (isOceanLayer) {
        buildOceanCurrentArrows(v.includes('Winter') ? 'winter' : 'summer');
    }
});

document.addEventListener('plates-edited', () => {
    updatePlanetCode(true);
    // If climate was invalidated and we're viewing a climate layer, switch to Terrain
    if (!state.climateComputed && CLIMATE_LAYERS.has(state.debugLayer)) {
        state.debugLayer = '';
        if (debugLayerEl) debugLayerEl.value = '';
        syncTabsToLayer('');
        updateMeshColors();
        updateLegend('');
    }
});

copyBtn.addEventListener('click', () => {
    if (!seedInput.value) return;
    navigator.clipboard.writeText(seedInput.value).then(() => {
        copyBtn.textContent = '\u2713';
        setTimeout(() => { copyBtn.textContent = '\u2398'; }, 1200);
    });
});

seedInput.addEventListener('input', () => {
    updateLoadBtn();
    seedError.classList.remove('visible');
});

const seedError = document.getElementById('seedError');

function paramsToSliderMap(params) {
    return {
        sN: sliderFromDetail(params.N), sJ: params.jitter, sP: params.P,
        sCn: params.numContinents, sNs: params.roughness,
        sCsv: params.continentSizeVariety, sLc: params.landCoverage,
        sTw: params.terrainWarp, sS: params.smoothing, sGl: params.glacialErosion,
        sHEr: params.hydraulicErosion, sTEr: params.thermalErosion,
        sRs: params.ridgeSharpening, sTmp: params.temperatureOffset,
        sPrc: params.precipitationOffset,
    };
}

function applyCode(code) {
    const params = decodePlanetCode(code);
    if (!params) {
        seedInput.style.borderColor = '#c44';
        seedError.classList.add('visible');
        setTimeout(() => { seedInput.style.borderColor = ''; }, 1500);
        return;
    }
    seedError.classList.remove('visible');
    pendingPlanetSeed = params.seed;
    // Set slider values + fire input events to update displays
    const map = paramsToSliderMap(params);
    planetCodeRefreshSuppressed = true;
    try {
        for (const [id, val] of Object.entries(map)) {
            const el = document.getElementById(id);
            el.value = val;
            el.dispatchEvent(new Event('input'));
        }
    } finally {
        planetCodeRefreshSuppressed = false;
    }
    currentCode = code.trim().toLowerCase();
    seedInput.value = currentCode;
    updateLoadBtn();
    history.replaceState(null, '', '#' + currentCode);
    clearReapplyPending();
    state.pendingToggles.clear();
    document.getElementById('rebuildFab').style.display = 'none';
    hideInitialPreview();
    showBuildOverlay();
    generate(params.seed, params.toggledIndices, onProgress, shouldSkipClimate());
}

loadBtn.addEventListener('click', () => {
    applyCode(seedInput.value);
});

seedInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyCode(seedInput.value);
});

// View-mode checkboxes
document.getElementById('chkPlates').addEventListener('change', () => { updateMeshColors(); updateSuperPlateBorders(); });
document.getElementById('chkWire').addEventListener('change', buildMesh);

// Grid toggle
const gridSpacingGroup = document.getElementById('gridSpacingGroup');
document.getElementById('chkGrid').addEventListener('change', (e) => {
    state.gridEnabled = e.target.checked;
    gridSpacingGroup.style.display = state.gridEnabled ? '' : 'none';
    if (state.mapMode) {
        if (state.mapGridMesh) state.mapGridMesh.visible = state.gridEnabled;
        if (state.globeGridMesh) state.globeGridMesh.visible = false;
    } else {
        if (state.globeGridMesh) state.globeGridMesh.visible = state.gridEnabled;
        if (state.mapGridMesh) state.mapGridMesh.visible = false;
    }
});

// Grid spacing dropdown
document.getElementById('gridSpacing').addEventListener('change', (e) => {
    state.gridSpacing = parseFloat(e.target.value);
    rebuildGrids();
});

// Flat map projection controls
const mapProjectionGroup = document.getElementById('mapProjectionGroup');
const sMapProjection = document.getElementById('sMapProjection');
const mapCenterLonGroup = document.getElementById('mapCenterLonGroup');
const sMapCenterLon = document.getElementById('sMapCenterLon');
const vMapCenterLon = document.getElementById('vMapCenterLon');
const mapCenterLatGroup = document.getElementById('mapCenterLatGroup');
const sMapCenterLat = document.getElementById('sMapCenterLat');
const vMapCenterLat = document.getElementById('vMapCenterLat');
const mapRotationGroup = document.getElementById('mapRotationGroup');
const sMapRotation = document.getElementById('sMapRotation');
const vMapRotation = document.getElementById('vMapRotation');
const mapZoomGroup = document.getElementById('mapZoomGroup');
const sMapZoom = document.getElementById('sMapZoom');
const vMapZoom = document.getElementById('vMapZoom');
const mapViewResetGroup = document.getElementById('mapViewResetGroup');
const mapViewResetBtn = document.getElementById('mapViewReset');
const MAP_VIEW_DEFAULTS = { lon: 0, lat: 0, rotation: 0, zoom: 1 };
const MAP_DRAG_MIN_DISTANCE = 4;
const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;
let mapProjectionRefreshTimer = 0;
let mapProjectionRefreshToken = 0;
let mapProjectionPreviewFrame = 0;
let mapProjectionDragging = false;
let mapZoomSyncing = false;

function rebuildProjectedFlowOverlays() {
    const layer = state.debugLayer;
    const isWind = layer === 'pressureSummer' || layer === 'pressureWinter' ||
                   layer === 'windSpeedSummer' || layer === 'windSpeedWinter';
    const isOcean = layer === 'oceanCurrentSummer' || layer === 'oceanCurrentWinter';
    if (isWind) buildWindArrows(layer.includes('Winter') ? 'winter' : 'summer');
    if (isOcean) buildOceanCurrentArrows(layer.includes('Winter') ? 'winter' : 'summer');
}

function rebuildMapProjectionView({ forceRebuild = false, overlays = true, previewOnly = false, lines = true } = {}) {
    if (!state.mapMode || !state.curData) return;
    const updated = !forceRebuild && updateMapProjectionMeshes(undefined, { previewOnly, lines });
    if (forceRebuild || (!updated && !previewOnly)) buildMapMesh();
    if (overlays) rebuildProjectedFlowOverlays();
    updateViewHint();
}

function rebuildMapProjectionViewWithOverlay(label = '正在重绘地图投影…') {
    if (!state.mapMode || !state.curData) return;
    if (state.mapMesh) {
        rebuildMapProjectionView();
        return;
    }
    if (mapProjectionRefreshTimer) {
        clearTimeout(mapProjectionRefreshTimer);
        mapProjectionRefreshTimer = 0;
    }
    if (mapProjectionPreviewFrame) {
        cancelAnimationFrame(mapProjectionPreviewFrame);
        mapProjectionPreviewFrame = 0;
    }
    const token = ++mapProjectionRefreshToken;
    showBuildOverlay();
    onProgress(5, label);
    setTimeout(() => {
        if (token !== mapProjectionRefreshToken) return;
        if (!state.mapMode) { hideBuildOverlay(); return; }
        try {
            onProgress(35, '正在构建地图网格…');
            rebuildMapProjectionView({ forceRebuild: true });
            onProgress(100, '地图投影已更新');
        } catch (err) {
            console.error('[MapProjection] Failed to rebuild projected map view:', err);
            onProgress(100, '地图投影更新失败');
        } finally {
            hideBuildOverlay();
        }
    }, 50);
}

function scheduleMapProjectionPreview() {
    if (!state.mapMode || !state.curData) return;
    if (mapProjectionPreviewFrame) return;
    mapProjectionPreviewFrame = requestAnimationFrame(() => {
        mapProjectionPreviewFrame = 0;
        rebuildMapProjectionView({
            overlays: false,
            previewOnly: mapProjectionDragging,
            lines: true,
        });
    });
}

function flushMapProjectionPreview({ overlays = true } = {}) {
    if (mapProjectionPreviewFrame) {
        cancelAnimationFrame(mapProjectionPreviewFrame);
        mapProjectionPreviewFrame = 0;
    }
    if (mapProjectionRefreshTimer) {
        clearTimeout(mapProjectionRefreshTimer);
        mapProjectionRefreshTimer = 0;
    }
    rebuildMapProjectionView({ overlays });
    setMapProjectionPreviewActive(false);
}

function scheduleMapProjectionRefresh({ overlay = false, debounce = true } = {}) {
    if (!state.mapMode || !state.curData) return;
    if (overlay && !state.mapMesh) {
        rebuildMapProjectionViewWithOverlay();
        return;
    }
    if (mapProjectionRefreshTimer) {
        if (!debounce) return;
        clearTimeout(mapProjectionRefreshTimer);
    }
    mapProjectionRefreshTimer = setTimeout(() => {
        mapProjectionRefreshTimer = 0;
        rebuildMapProjectionView({ overlays: false });
    }, 16);
}

function clampMapCenter(value, input) {
    const min = Number(input.min);
    const max = Number(input.max);
    return Math.max(min, Math.min(max, value));
}

function snapMapCenter(value, input) {
    const min = Number(input.min);
    const step = Number(input.step) || 1;
    const decimals = step < 1 ? String(step).split('.')[1].length : 0;
    const snapped = min + Math.round((value - min) / step) * step;
    return Number(clampMapCenter(snapped, input).toFixed(decimals));
}

function wrapMapCenterLon(deg) {
    let wrapped = ((deg + 180) % 360 + 360) % 360 - 180;
    if (wrapped === -180 && deg > 0) wrapped = 180;
    return wrapped;
}

function formatMapZoomLabel(value) {
    return Number(value).toFixed(2) + '×';
}

function setMapCenterControls(lon, lat, { refresh = 'preview', overlay = false } = {}) {
    const snappedLon = snapMapCenter(wrapMapCenterLon(lon), sMapCenterLon);
    const snappedLat = snapMapCenter(lat, sMapCenterLat);
    sMapCenterLon.value = snappedLon;
    vMapCenterLon.textContent = formatLonLabel(snappedLon);
    state.mapCenterLon = snappedLon * Math.PI / 180;
    sMapCenterLat.value = snappedLat;
    vMapCenterLat.textContent = formatLatLabel(snappedLat);
    state.mapCenterLat = snappedLat * Math.PI / 180;
    if (refresh === 'immediate') flushMapProjectionPreview();
    else if (refresh === 'preview') scheduleMapProjectionPreview();
    else if (refresh === 'schedule') scheduleMapProjectionRefresh({ overlay, debounce: overlay });
}

function setMapRotationControls(rotation, { refresh = 'preview', overlay = false } = {}) {
    const snappedRotation = snapMapCenter(wrapMapCenterLon(rotation), sMapRotation);
    sMapRotation.value = snappedRotation;
    vMapRotation.textContent = `${snappedRotation}°`;
    state.mapRotation = snappedRotation * DEG_TO_RAD;
    if (refresh === 'immediate') flushMapProjectionPreview();
    else if (refresh === 'preview') scheduleMapProjectionPreview();
    else if (refresh === 'schedule') scheduleMapProjectionRefresh({ overlay, debounce: overlay });
}

function setMapOrientationControls(lon, lat, rotation, { refresh = 'preview', overlay = false } = {}) {
    setMapCenterControls(lon, lat, { refresh: 'none' });
    setMapRotationControls(rotation, { refresh: 'none' });
    if (refresh === 'immediate') flushMapProjectionPreview();
    else if (refresh === 'preview') scheduleMapProjectionPreview();
    else if (refresh === 'schedule') scheduleMapProjectionRefresh({ overlay, debounce: overlay });
}

function setMapZoomControls(zoom, { immediate = false, syncCamera = true } = {}) {
    const snappedZoom = snapMapCenter(zoom, sMapZoom);
    sMapZoom.value = snappedZoom;
    vMapZoom.textContent = formatMapZoomLabel(snappedZoom);
    state.mapZoom = snappedZoom;
    if (syncCamera && !mapZoomSyncing) setMapCameraZoom(snappedZoom, { immediate });
}

function resetMapViewControls() {
    resetMapCameraView();
    setMapOrientationControls(MAP_VIEW_DEFAULTS.lon, MAP_VIEW_DEFAULTS.lat, MAP_VIEW_DEFAULTS.rotation, { refresh: 'none' });
    setMapZoomControls(MAP_VIEW_DEFAULTS.zoom, { immediate: true });
    flushMapProjectionPreview();
    updateViewHint();
}

if (sMapProjection) {
    sMapProjection.addEventListener('change', () => {
        state.mapProjection = sMapProjection.value;
        flushMapProjectionPreview();
    });
}

sMapCenterLon.addEventListener('input', () => {
    setMapCenterControls(+sMapCenterLon.value, +sMapCenterLat.value);
});

sMapCenterLon.addEventListener('change', () => {
    flushMapProjectionPreview();
});

sMapCenterLat.addEventListener('input', () => {
    setMapCenterControls(+sMapCenterLon.value, +sMapCenterLat.value);
});

sMapCenterLat.addEventListener('change', () => {
    flushMapProjectionPreview();
});

if (sMapRotation) {
    sMapRotation.addEventListener('input', () => {
        setMapRotationControls(+sMapRotation.value);
    });

    sMapRotation.addEventListener('change', () => {
        flushMapProjectionPreview();
    });
}

if (sMapZoom) {
    sMapZoom.addEventListener('input', () => {
        setMapZoomControls(+sMapZoom.value);
    });
}

window.addEventListener('map-zoom-changed', (e) => {
    const zoom = e.detail?.zoom;
    if (!Number.isFinite(zoom) || !sMapZoom) return;
    if (mapZoomSyncing) return;
    mapZoomSyncing = true;
    try {
        const snappedZoom = snapMapCenter(zoom, sMapZoom);
        setMapZoomControls(snappedZoom, { syncCamera: false });
        if (Math.abs(snappedZoom - zoom) > 0.0001) setMapCameraZoom(snappedZoom);
    } finally {
        mapZoomSyncing = false;
    }
});

if (mapViewResetBtn) {
    mapViewResetBtn.addEventListener('click', resetMapViewControls);
}

function initMapCenterDrag() {
    let drag = null;
    const activePointers = new Set();

    function canDragMapCenter(e) {
        return state.mapMode && state.curData && e.button === 0 && !e.ctrlKey &&
            !(state.isTouchDevice && state.editMode);
    }

    function pointerToMapPoint(e) {
        const rect = canvas.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const ndcX = (e.clientX - rect.left) / rect.width * 2 - 1;
        const ndcY = -((e.clientY - rect.top) / rect.height * 2 - 1);
        return {
            x: mapCamera.position.x + ndcX * (mapCamera.right - mapCamera.left) / (2 * mapCamera.zoom),
            y: mapCamera.position.y + ndcY * (mapCamera.top - mapCamera.bottom) / (2 * mapCamera.zoom),
        };
    }

    function cancelDrag() {
        if (!drag) return;
        const id = drag.id;
        drag = null;
        mapProjectionDragging = false;
        setMapProjectionPreviewActive(false);
        canvas.classList.remove('map-center-dragging');
        try { canvas.releasePointerCapture(id); } catch (_) {}
    }

    canvas.addEventListener('pointerdown', (e) => {
        if (!canDragMapCenter(e)) return;
        activePointers.add(e.pointerId);
        if (e.pointerType === 'touch' && activePointers.size > 1) {
            cancelDrag();
            return;
        }
        const startPoint = pointerToMapPoint(e);
        if (!startPoint) return;
        const params = getMapProjectionParams();
        drag = {
            id: e.pointerId,
            startX: e.clientX,
            startY: e.clientY,
            startPoint,
            startParams: { ...params },
            moved: false,
        };
        mapProjectionDragging = true;
        setMapProjectionPreviewActive(true, params);
        e.preventDefault();
        e.stopImmediatePropagation();
        canvas.classList.add('map-center-dragging');
        try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    }, true);

    canvas.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return;
        const dx = e.clientX - drag.startX;
        const dy = e.clientY - drag.startY;
        drag.moved = drag.moved || Math.hypot(dx, dy) >= MAP_DRAG_MIN_DISTANCE;
        const currentPoint = pointerToMapPoint(e);
        if (currentPoint) {
            const next = rotateMapProjectionParamsByDrag(drag.startParams, drag.startPoint, currentPoint);
            if (next) {
                setMapOrientationControls(
                    next.centerLon * RAD_TO_DEG,
                    next.centerLat * RAD_TO_DEG,
                    next.rotation * RAD_TO_DEG,
                    { overlay: false }
                );
            }
        }
        e.preventDefault();
        e.stopImmediatePropagation();
    }, true);

    function finishDrag(e) {
        activePointers.delete(e.pointerId);
        if (!drag || e.pointerId !== drag.id) return;
        const moved = drag.moved;
        drag = null;
        mapProjectionDragging = false;
        canvas.classList.remove('map-center-dragging');
        try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
        if (mapProjectionRefreshTimer) {
            clearTimeout(mapProjectionRefreshTimer);
            mapProjectionRefreshTimer = 0;
        }
        if (moved) flushMapProjectionPreview();
        else setMapProjectionPreviewActive(false);
        e.preventDefault();
        e.stopImmediatePropagation();
    }

    canvas.addEventListener('pointerup', finishDrag, true);
    canvas.addEventListener('pointercancel', finishDrag, true);
}

initMapCenterDrag();

function updateViewHint() {
    if (!state.curData) {
        const hint = '调整塑造世界参数 · 点击生成新世界';
        for (const id of ['topInfo', 'info']) {
            const el = document.getElementById(id);
            if (el) el.textContent = hint;
        }
        return;
    }
    const globeHint = state.isTouchDevice
        ? '拖拽旋转 · 双指缩放 · 使用编辑按钮重塑'
        : '拖拽旋转 · 滚轮缩放 · Ctrl 点击重塑大陆';
    const hint = state.mapMode
        ? `左键旋转投影 · 右键平移 · 滚轮缩放 · ${getMapProjectionLabel()} 投影`
        : state.freeCameraMode
            ? 'WASD 移动 · Q/E 上下 · 按住鼠标右键转动视角'
            : globeHint;
    for (const id of ['topInfo', 'info']) {
        const el = document.getElementById(id);
        if (el) el.textContent = hint;
    }
}

function syncWorldReadyControls() {
    const ready = !!state.curData;
    const exportBtn = document.getElementById('exportBtn');
    if (exportBtn) {
        exportBtn.disabled = !ready;
        exportBtn.title = ready ? '导出地图' : '请先生成一个世界';
    }

    const editBtn = document.getElementById('editToggle');
    if (editBtn) {
        editBtn.disabled = !ready;
        editBtn.title = ready ? '切换板块编辑模式' : '请先生成一个世界';
        if (!ready) {
            state.editMode = false;
            editBtn.classList.remove('active');
        }
    }
}

// View mode dropdown (Globe / Free Camera / Map)
function setViewMode(mode) {
    state.mapMode = mode === 'map';
    state.freeCameraMode = mode === 'free';
    setFreeCameraControls(state.freeCameraMode);

    if (state.mapMode) {
        if (state.planetMesh) state.planetMesh.visible = false;
        waterMesh.visible = false;
        atmosMesh.visible = false;
        starsMesh.visible = false;
        if (state.wireMesh) state.wireMesh.visible = false;
        if (state.arrowGroup) state.arrowGroup.visible = false;
        if (state.curData && !state.mapMesh) {
            showBuildOverlay();
            onProgress(0, '正在构建地图网格\u2026');
            // Yield to let the overlay paint, then build the mesh
            setTimeout(() => {
                buildMapMesh();
                if (state.mapMesh) state.mapMesh.visible = true;
                hideBuildOverlay();
            }, 50);
        }
        setMapProjectionPreviewActive(false);
        if (state.mapMesh) state.mapMesh.visible = true;
        if (state.mapGridMesh) state.mapGridMesh.visible = state.gridEnabled;
        if (state.globeGridMesh) state.globeGridMesh.visible = false;
        // Toggle wind arrow sub-groups for map mode
        if (state.windArrowGroup) {
            state.windArrowGroup.traverse(c => {
                if (c.name === 'windGlobe') c.visible = false;
                if (c.name === 'windMap') c.visible = true;
            });
        }
        if (state.oceanCurrentArrowGroup) {
            state.oceanCurrentArrowGroup.traverse(c => {
                if (c.name === 'oceanGlobe') c.visible = false;
                if (c.name === 'oceanMap') c.visible = true;
            });
        }
        scene.background = new THREE.Color(0x1a1a2e);
        ctrl.enabled = false;
        mapCtrl.enabled = true;
        mapCamera.position.set(0, 0, 5);
        mapCamera.lookAt(0, 0, 0);
        updateMapCameraFrustum();
        mapCtrl.target.set(0, 0, 0);
        mapCtrl.update();
        mapProjectionGroup.style.display = '';
        mapCenterLonGroup.style.display = '';
        mapCenterLatGroup.style.display = '';
        if (mapRotationGroup) mapRotationGroup.style.display = '';
        if (mapZoomGroup) mapZoomGroup.style.display = '';
        if (mapViewResetGroup) mapViewResetGroup.style.display = '';
    } else {
        if (state.planetMesh) state.planetMesh.visible = true;
        atmosMesh.visible = true;
        starsMesh.visible = true;
        if (state.wireMesh) state.wireMesh.visible = true;
        if (state.arrowGroup) state.arrowGroup.visible = true;
        setMapProjectionPreviewActive(false);
        if (state.mapMesh) state.mapMesh.visible = false;
        if (state.mapGridMesh) state.mapGridMesh.visible = false;
        if (state.globeGridMesh) state.globeGridMesh.visible = state.gridEnabled;
        // Toggle wind arrow sub-groups for globe mode
        if (state.windArrowGroup) {
            state.windArrowGroup.traverse(c => {
                if (c.name === 'windGlobe') c.visible = true;
                if (c.name === 'windMap') c.visible = false;
            });
        }
        if (state.oceanCurrentArrowGroup) {
            state.oceanCurrentArrowGroup.traverse(c => {
                if (c.name === 'oceanGlobe') c.visible = true;
                if (c.name === 'oceanMap') c.visible = false;
            });
        }
        const showPlates = document.getElementById('chkPlates').checked;
        waterMesh.visible = !showPlates && !state.debugLayer;
        scene.background = new THREE.Color(0x030308);
        mapCtrl.enabled = false;
        ctrl.enabled = !state.freeCameraMode;
        if (!state.freeCameraMode) recenterGlobeCamera();
        mapProjectionGroup.style.display = 'none';
        mapCenterLonGroup.style.display = 'none';
        mapCenterLatGroup.style.display = 'none';
        if (mapRotationGroup) mapRotationGroup.style.display = 'none';
        if (mapZoomGroup) mapZoomGroup.style.display = 'none';
        if (mapViewResetGroup) mapViewResetGroup.style.display = 'none';
    }

    updateSuperPlateBorders();
    updateViewHint();
}

document.getElementById('viewMode').addEventListener('change', (e) => setViewMode(e.target.value));

// Debug layer dropdown
if (debugLayerEl) {
    debugLayerEl.addEventListener('change', (e) => {
        const layer = e.target.value;
        syncTabsToLayer(layer);
        switchVisualization(layer);
    });
}

// Export modal
(function initExport() {
    const overlay        = document.getElementById('exportOverlay');
    const closeBtn       = document.getElementById('exportClose');
    const cancelBtn      = document.getElementById('exportCancel');
    const goBtn          = document.getElementById('exportGo');
    const widthEl        = document.getElementById('exportWidth');
    const dimsEl         = document.getElementById('exportDims');
    const typeEl         = document.getElementById('exportType');
    const openBtn        = document.getElementById('exportBtn');
    const exportAllBtn   = document.getElementById('exportAllGo');
    const modelFormatEl  = document.getElementById('exportModelFormat');
    const debugLayerList = document.getElementById('exportDebugLayerList');

    const DEFAULT_BUNDLE_TYPES = [
        { type: 'color',     label: '地形图' },
        { type: 'biome',     label: '卫星图' },
        { type: 'koppen',    label: '气候图' },
        { type: 'heightmap', label: '高度图' },
    ];
    const EXTRA_BUNDLE_TYPES = [
        { type: 'landmask', label: '陆地遮罩' },
    ];
    const DEFAULT_OPTIONAL_EXCLUDE = new Set(['', 'biome', 'koppen', 'heightmap']);

    function updateDims() {
        const w = +widthEl.value;
        dimsEl.textContent = w + ' \u00D7 ' + (w / 2);
    }

    function debugExportOptions() {
        const out = [...EXTRA_BUNDLE_TYPES];
        const seen = new Set(out.map(opt => opt.type));
        if (!debugLayerEl) return out;
        for (const opt of debugLayerEl.options) {
            const type = opt.value;
            if (!type || DEFAULT_OPTIONAL_EXCLUDE.has(type) || seen.has(type)) continue;
            out.push({ type, label: opt.textContent.trim() || type });
            seen.add(type);
        }
        return out;
    }

    function renderExportDebugOptions() {
        if (!debugLayerList) return;
        const checked = new Set([...debugLayerList.querySelectorAll('input[type="checkbox"]:checked')].map(input => input.value));
        debugLayerList.replaceChildren();
        const options = debugExportOptions();
        if (!options.length) {
            const note = document.createElement('p');
            note.className = 'export-note';
            note.textContent = '当前没有额外的检视图层可导出。';
            debugLayerList.appendChild(note);
            return;
        }
        for (const opt of options) {
            const label = document.createElement('label');
            label.className = 'export-check';
            const input = document.createElement('input');
            input.type = 'checkbox';
            input.value = opt.type;
            input.checked = checked.has(opt.type);
            label.append(input, document.createTextNode(opt.label));
            debugLayerList.appendChild(label);
        }
    }

    function initDebugOptionDragSelect() {
        if (!debugLayerList) return;
        let drag = null;
        let suppressClick = false;
        const inputSelector = 'input[type="checkbox"]';

        function optionInputs() {
            return [...debugLayerList.querySelectorAll(inputSelector)];
        }

        function checkboxAt(clientX, clientY) {
            const el = document.elementFromPoint(clientX, clientY);
            const label = el?.closest?.('.export-check');
            if (!label || !debugLayerList.contains(label)) return null;
            return label.querySelector(inputSelector);
        }

        function applyTo(input) {
            if (!drag || !input || drag.visited.has(input)) return;
            input.checked = drag.checked;
            drag.visited.add(input);
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }

        function applyRangeTo(input) {
            if (!drag || !input) return;
            const inputs = optionInputs();
            const nextIndex = inputs.indexOf(input);
            if (nextIndex === -1) return;
            const from = Number.isInteger(drag.lastIndex) ? drag.lastIndex : nextIndex;
            const lo = Math.min(from, nextIndex);
            const hi = Math.max(from, nextIndex);
            for (let i = lo; i <= hi; i++) applyTo(inputs[i]);
            drag.lastIndex = nextIndex;
        }

        function autoScroll(clientY) {
            const rect = debugLayerList.getBoundingClientRect();
            const edge = 28;
            if (clientY < rect.top + edge) debugLayerList.scrollTop -= 12;
            else if (clientY > rect.bottom - edge) debugLayerList.scrollTop += 12;
        }

        debugLayerList.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            const input = checkboxAt(e.clientX, e.clientY);
            if (!input) return;
            const startIndex = optionInputs().indexOf(input);
            if (startIndex === -1) return;
            drag = { id: e.pointerId, checked: !input.checked, visited: new Set(), lastIndex: startIndex };
            suppressClick = true;
            debugLayerList.classList.add('drag-selecting');
            applyTo(input);
            e.preventDefault();
            try { debugLayerList.setPointerCapture(e.pointerId); } catch (_) {}
        });

        debugLayerList.addEventListener('pointermove', (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            autoScroll(e.clientY);
            applyRangeTo(checkboxAt(e.clientX, e.clientY));
            e.preventDefault();
        });

        function finish(e) {
            if (!drag || e.pointerId !== drag.id) return;
            drag = null;
            debugLayerList.classList.remove('drag-selecting');
            try { debugLayerList.releasePointerCapture(e.pointerId); } catch (_) {}
            e.preventDefault();
        }

        debugLayerList.addEventListener('pointerup', finish);
        debugLayerList.addEventListener('pointercancel', finish);
        debugLayerList.addEventListener('click', (e) => {
            if (!suppressClick) return;
            suppressClick = false;
            e.preventDefault();
            e.stopImmediatePropagation();
        }, true);
    }

    function selectedBundleTypes() {
        const labels = new Map(debugExportOptions().map(opt => [opt.type, opt.label]));
        const out = [...DEFAULT_BUNDLE_TYPES];
        if (!debugLayerList) return out;
        for (const input of debugLayerList.querySelectorAll('input[type="checkbox"]:checked')) {
            out.push({ type: input.value, label: labels.get(input.value) || input.value });
        }
        return out;
    }

    function needsClimate(types) {
        return types.some(item => item && CLIMATE_LAYERS.has(item.type));
    }

    async function ensureClimate(types) {
        if (state.climateComputed || !needsClimate(types)) return;
        onProgress(0, '正在计算气候...');
        await new Promise(resolve => computeClimateViaWorker(onProgress, resolve));
    }

    function reportExportError(err) {
        console.error(err);
        alert('导出失败，请降低导出宽度、减少可选图层或更换浏览器后重试。');
    }

    function openModal() {
        if (!state.curData) {
            alert('请先生成一个世界再导出。');
            syncWorldReadyControls();
            return;
        }
        overlay.classList.remove('hidden');
        updateDims();
        renderExportDebugOptions();
        // Disable climate-dependent export types when climate isn't computed
        for (const opt of typeEl.options) {
            if (opt.value === 'biome' || opt.value === 'koppen') {
                opt.disabled = !state.climateComputed;
                if (opt.disabled && typeEl.value === opt.value) typeEl.value = 'color';
            }
        }
    }
    function closeModal() { overlay.classList.add('hidden'); }

    openBtn.addEventListener('click', openModal);
    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    initDebugOptionDragSelect();
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeModal();
    });
    widthEl.addEventListener('change', updateDims);

    goBtn.addEventListener('click', async () => {
        const type = typeEl.value;
        const w = +widthEl.value;
        closeModal();
        showBuildOverlay();
        try {
            onProgress(0, '正在准备导出...');
            await exportMap(type, w, onProgress);
        } catch (err) {
            reportExportError(err);
        } finally {
            hideBuildOverlay();
        }
    });

    exportAllBtn.addEventListener('click', async () => {
        const w = +widthEl.value;
        const textureTypes = selectedBundleTypes();
        const modelFormat = modelFormatEl ? modelFormatEl.value : '';
        closeModal();
        showBuildOverlay();
        try {
            await ensureClimate(textureTypes);
            await exportWorldBundle({ width: w, textureTypes, modelFormat }, onProgress);
        } catch (err) {
            reportExportError(err);
        } finally {
            hideBuildOverlay();
        }
    });
})();

// Edit mode setup (pointer events, sub-mode buttons)
setupEditMode();

// Rebuild FAB — batch-apply pending plate toggles
(function initRebuildFab() {
    const rebuildBtn = document.getElementById('rebuildFab');
    const rebuildLabel = rebuildBtn.querySelector('span');

    function clearPending() {
        state.pendingToggles.clear();
        rebuildBtn.style.display = 'none';
        state._pendingBackup = null;
        state._mapPendingBackup = null;
        updatePendingHighlight();
        updateMapPendingHighlight();
    }

    // Show/hide rebuild button when pending set changes
    document.addEventListener('pending-edits-changed', () => {
        const count = state.pendingToggles.size;
        if (count > 0) {
            rebuildLabel.textContent = `重建 (${count})`;
            rebuildBtn.style.display = '';
        } else {
            rebuildBtn.style.display = 'none';
        }
    });

    // Click: apply all pending toggles, then recompute once
    rebuildBtn.addEventListener('click', () => {
        if (state.pendingToggles.size === 0) return;
        const { plateIsOcean, plateDensity, plateDensityLand, plateDensityOcean } = state.curData;

        // Apply all pending toggles
        for (const pid of state.pendingToggles) {
            if (plateIsOcean.has(pid)) {
                plateIsOcean.delete(pid);
                plateDensity[pid] = plateDensityLand[pid];
            } else {
                plateIsOcean.add(pid);
                plateDensity[pid] = plateDensityOcean[pid];
            }
        }

        clearPending();

        // Show building state
        const btn = document.getElementById('generate');
        btn.disabled = true;
        btn.textContent = '生成中\u2026';
        btn.classList.add('generating');

        const hoverEl = document.getElementById('hoverInfo');
        hoverEl.innerHTML = '\u23F3 正在重建\u2026';
        hoverEl.style.display = 'block';

        const skipClimate = shouldSkipClimate();
        editRecomputeViaWorker(() => {
            btn.disabled = false;
            btn.textContent = '生成新世界';
            btn.classList.remove('generating');
            hoverEl.style.display = 'none';
            document.dispatchEvent(new CustomEvent('plates-edited'));
        }, skipClimate);
    });

    // Escape clears all pending edits
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && state.pendingToggles.size > 0) {
            clearPending();
        }
    });

    // Clear pending on new generation
    genBtn.addEventListener('generate-done', clearPending);
})();

// Sidebar toggle (desktop) + bottom sheet (mobile)
const sidebarToggle = document.getElementById('sidebarToggle');
const uiPanel = document.getElementById('ui');
const isMobileLayout = () => window.innerWidth <= 768;

if (isMobileLayout()) {
    uiPanel.classList.add('collapsed');
}

// Desktop sidebar toggle
sidebarToggle.addEventListener('click', () => {
    const collapsed = uiPanel.classList.toggle('collapsed');
    sidebarToggle.innerHTML = collapsed ? '\u00BB' : '\u00AB';
    sidebarToggle.title = collapsed ? '显示面板' : '收起面板';
});

// Bottom-sheet drag behavior (Pointer Events + setPointerCapture)
(function initBottomSheet() {
    const handle = document.getElementById('sheetHandle');
    if (!handle) return;

    let startY = 0, startTransform = 0, dragging = false;
    let lastY = 0, lastTime = 0, velocity = 0;
    let didDrag = false;
    let rafId = 0, pendingY = null;

    function getTranslateY() {
        const st = getComputedStyle(uiPanel);
        const m = new DOMMatrix(st.transform);
        return m.m42;
    }

    function getCollapsedY() {
        return uiPanel.offsetHeight - 60;
    }

    function applyTransform() {
        if (pendingY !== null) {
            uiPanel.style.transform = `translateY(${pendingY}px)`;
            pendingY = null;
        }
        rafId = 0;
    }

    function scheduleTransform(y) {
        pendingY = y;
        if (!rafId) rafId = requestAnimationFrame(applyTransform);
    }

    function cleanup() {
        dragging = false;
        uiPanel.style.transition = '';
        uiPanel.classList.remove('dragging');
        if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
        pendingY = null;
    }

    handle.addEventListener('pointerdown', (e) => {
        if (!isMobileLayout()) return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        dragging = true;
        didDrag = false;
        startY = e.clientY;
        lastY = e.clientY;
        lastTime = performance.now();
        velocity = 0;
        startTransform = uiPanel.classList.contains('collapsed') ? getTranslateY() : 0;
        uiPanel.style.transition = 'none';
        uiPanel.classList.add('dragging');
    });

    handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const y = e.clientY;
        const now = performance.now();
        const dt = now - lastTime;
        if (dt > 0) velocity = (y - lastY) / dt; // px/ms, positive = downward
        lastY = y;
        lastTime = now;
        const dy = y - startY;
        if (Math.abs(dy) > 5) didDrag = true;
        const collapsedY = getCollapsedY();
        const newY = Math.max(0, Math.min(collapsedY, startTransform + dy));
        scheduleTransform(newY);
    });

    handle.addEventListener('pointerup', (e) => {
        if (!dragging) return;
        handle.releasePointerCapture(e.pointerId);
        cleanup();
        const curY = getTranslateY();
        const collapsedY = getCollapsedY();
        const progress = collapsedY > 0 ? 1 - curY / collapsedY : 0;
        const shouldCollapse = velocity > 0.3 || (velocity > -0.3 && progress < 0.3);
        if (shouldCollapse) {
            uiPanel.classList.add('collapsed');
        } else {
            uiPanel.classList.remove('collapsed');
        }
        uiPanel.style.transform = '';
    });

    handle.addEventListener('pointercancel', (e) => {
        if (!dragging) return;
        try { handle.releasePointerCapture(e.pointerId); } catch (_) {}
        cleanup();
        uiPanel.style.transform = '';
    });

    // Tap on handle toggles collapsed state (suppressed if a drag just happened)
    handle.addEventListener('click', () => {
        if (!isMobileLayout()) return;
        if (didDrag) { didDrag = false; return; }
        uiPanel.classList.toggle('collapsed');
    });
})();

// Edit-mode toggle wiring
(function initEditToggle() {
    const editBtn = document.getElementById('editToggle');
    if (!editBtn) return;
    editBtn.addEventListener('click', () => {
        if (!state.curData) return;
        state.editMode = !state.editMode;
        editBtn.classList.toggle('active', state.editMode);
    });
})();

// Mobile refresh FAB — two-tap to regenerate (blue → green → generate)
(function initRefreshFab() {
    const btn = document.getElementById('refreshFab');
    if (!btn) return;
    let armed = false;
    let timer = 0;

    function disarm() {
        armed = false;
        btn.classList.remove('armed');
        clearTimeout(timer);
    }

    btn.addEventListener('click', () => {
        if (!armed) {
            armed = true;
            btn.classList.add('armed');
            timer = setTimeout(disarm, 3000);
        } else {
            disarm();
            // Collapse sheet so user sees the planet build
            if (isMobileLayout()) uiPanel.classList.add('collapsed');
            clearReapplyPending();
            hideInitialPreview();
            showBuildOverlay();
            const seed = randomPlanetSeedExcept(state.curData ? state.curData.seed : pendingPlanetSeed);
            pendingPlanetSeed = seed;
            updatePlanetCode(false);
            generate(seed, [], onProgress, shouldSkipClimate());
        }
    });
})();

// Mobile info text
if (state.isTouchDevice) {
    updateViewHint();
}

// Disable export widths > 8192 on touch devices
if (state.isTouchDevice) {
    const exportWidth = document.getElementById('exportWidth');
    if (exportWidth) {
        for (const opt of exportWidth.options) {
            if (+opt.value > 8192) {
                opt.disabled = true;
                opt.textContent = opt.value + '（移动端过大）';
            }
        }
    }
}

// Orientation change handler
window.addEventListener('orientationchange', () => {
    setTimeout(() => {
        camera.aspect = innerWidth / innerHeight;
        camera.updateProjectionMatrix();
        updateMapCameraFrustum();
        renderer.setSize(innerWidth, innerHeight);
    }, 100);
});

// Animation loop
function animate() {
    requestAnimationFrame(animate);
    if (state.mapMode) {
        tickMapZoom();
        mapCtrl.update();
    } else if (state.freeCameraMode) {
        tickFreeCamera();
    } else {
        tickZoom();
        ctrl.update();
    }
    if (!state.mapMode && !state.freeCameraMode && state.planetMesh && document.getElementById('chkRotate').checked) {
        state.planetMesh.rotation.y += 0.0008;
        waterMesh.rotation.y = state.planetMesh.rotation.y;
        if (state.wireMesh) state.wireMesh.rotation.y = state.planetMesh.rotation.y;
        if (state.superPlateBorderMesh) state.superPlateBorderMesh.rotation.y = state.planetMesh.rotation.y;
        if (state.arrowGroup) state.arrowGroup.rotation.y = state.planetMesh.rotation.y;
        if (state.windArrowGroup) state.windArrowGroup.rotation.y = state.planetMesh.rotation.y;
        if (state.oceanCurrentArrowGroup) state.oceanCurrentArrowGroup.rotation.y = state.planetMesh.rotation.y;
        if (state.globeGridMesh) state.globeGridMesh.rotation.y = state.planetMesh.rotation.y;
    }
    renderer.render(scene, state.mapMode ? mapCamera : camera);
}

// Resize handler
window.addEventListener('resize', () => {
    camera.aspect = innerWidth/innerHeight;
    camera.updateProjectionMatrix();
    updateMapCameraFrustum();
    renderer.setSize(innerWidth, innerHeight);
});

// Tutorial modal
(function initTutorial() {
    const overlay  = document.getElementById('tutorialOverlay');
    const card     = document.getElementById('tutorialCard');
    const closeBtn = document.getElementById('tutorialClose');
    const backBtn  = document.getElementById('tutorialBack');
    const nextBtn  = document.getElementById('tutorialNext');
    const helpBtn  = document.getElementById('helpBtn');
    const steps    = card.querySelectorAll('.tutorial-step');
    const dots     = card.querySelectorAll('.dot');
    const TOTAL    = steps.length;
    const LS_KEY   = 'atlas-engine-tutorial-seen';
    let current    = 0;

    function showStep(i) {
        current = i;
        steps.forEach((s, idx) => s.classList.toggle('active', idx === i));
        dots.forEach((d, idx) => d.classList.toggle('active', idx === i));
        backBtn.disabled = i === 0;
        nextBtn.textContent = i === TOTAL - 1 ? '开始使用' : '下一步';
    }

    function openModal() {
        current = 0;
        showStep(0);
        overlay.classList.remove('hidden');
    }

    function closeModal() {
        overlay.classList.add('hidden');
        localStorage.setItem(LS_KEY, '1');
    }

    nextBtn.addEventListener('click', () => {
        if (current < TOTAL - 1) showStep(current + 1);
        else closeModal();
    });

    backBtn.addEventListener('click', () => {
        if (current > 0) showStep(current - 1);
    });

    closeBtn.addEventListener('click', closeModal);

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeModal();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeModal();
    });

    helpBtn.addEventListener('click', openModal);

    // Update tutorial step 2 for touch devices
    if (state.isTouchDevice) {
        const step2 = card.querySelector('.tutorial-step[data-step="2"]');
        if (step2) {
            const p = step2.querySelector('p');
            if (p) p.innerHTML = '<strong>拖拽</strong>旋转星球，<strong>双指捏合</strong>缩放。点击<strong>编辑按钮</strong>（铅笔图标）后，再<strong>轻点</strong>板块即可标记为待重塑；可多选后点击<strong>重建</strong>一次性应用。再次轻点可取消待处理选择。';
        }
    }

    // Auto-show on first visit. If no world is being loaded, show over the static preview.
    overlay.classList.add('hidden');
    if (!localStorage.getItem(LS_KEY)) {
        setTimeout(() => {
            if (!state.curData && !startupGenerationInProgress && !genBtn.classList.contains('generating')) openModal();
        }, 700);
        genBtn.addEventListener('generate-done', () => {
            if (buildOverlay) {
                buildOverlay.addEventListener('transitionend', () => openModal(), { once: true });
            } else {
                openModal();
            }
        }, { once: true });
    }
})();

// What's New modal — shown once per version for returning users
(function initWhatsNew() {
    const VERSION    = '2';
    const LS_KEY     = 'wo-whatsnew-seen';
    const LS_TUTORIAL = 'atlas-engine-tutorial-seen';
    const overlay    = document.getElementById('whatsNewOverlay');
    const card       = document.getElementById('whatsNewCard');
    if (!overlay || !card) return;

    const closeBtn = document.getElementById('whatsNewClose');
    const backBtn  = document.getElementById('whatsNewBack');
    const nextBtn  = document.getElementById('whatsNewNext');
    const steps    = card.querySelectorAll('.whatsnew-step');
    const dots     = card.querySelectorAll('.dot');
    const TOTAL    = steps.length;
    let current    = 0;

    function showStep(i) {
        current = i;
        steps.forEach((s, idx) => s.classList.toggle('active', idx === i));
        dots.forEach((d, idx) => d.classList.toggle('active', idx === i));
        backBtn.disabled = i === 0;
        nextBtn.textContent = i === TOTAL - 1 ? '知道了' : '下一步';
    }

    function closeModal() {
        overlay.classList.add('hidden');
        localStorage.setItem(LS_KEY, VERSION);
    }

    nextBtn.addEventListener('click', () => {
        if (current < TOTAL - 1) showStep(current + 1);
        else closeModal();
    });
    backBtn.addEventListener('click', () => {
        if (current > 0) showStep(current - 1);
    });
    closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !overlay.classList.contains('hidden')) closeModal();
    });

    // Only show for returning users (tutorial already seen) who haven't seen this version
    overlay.classList.add('hidden');
    const seenVersion = localStorage.getItem(LS_KEY);
    const isReturningUser = localStorage.getItem(LS_TUTORIAL);
    if (isReturningUser && seenVersion !== VERSION) {
        genBtn.addEventListener('generate-done', () => {
            showStep(0);
            setTimeout(() => overlay.classList.remove('hidden'), 600);
        }, { once: true });
    }
})();

// Power-user survey — triggers after 3+ distinct hours across 2+ distinct days
(function initSurveyTracker() {
    const LS = 'wo-usage';
    const LS_DISMISSED = 'wo-survey-dismissed';

    if (localStorage.getItem(LS_DISMISSED)) return;

    // Simple hash so we don't store raw timestamps
    function hash(str) {
        let h = 5381;
        for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
        return h.toString(36);
    }

    let data;
    try { data = JSON.parse(localStorage.getItem(LS)) || {}; } catch (_) { data = {}; }
    const hours = data.h || 0;
    const days  = data.d || 0;
    const lastH = data.lh || '';
    const lastD = data.ld || '';

    const now = new Date();
    const hourKey = hash(now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate() + 'T' + now.getHours());
    const dayKey  = hash(now.getFullYear() + '-' + now.getMonth() + '-' + now.getDate());

    const newHours = hourKey !== lastH ? hours + 1 : hours;
    const newDays  = dayKey  !== lastD ? days  + 1 : days;

    localStorage.setItem(LS, JSON.stringify({ h: newHours, d: newDays, lh: hourKey, ld: dayKey }));

    if (newHours >= 3 && newDays >= 2) {
        const overlay    = document.getElementById('surveyOverlay');
        const closeBtn   = document.getElementById('surveyClose');
        const dismissBtn = document.getElementById('surveyDismiss');
        const linkBtn    = document.getElementById('surveyLink');
        if (!overlay) return;

        function dismiss() {
            overlay.classList.add('hidden');
            localStorage.setItem(LS_DISMISSED, '1');
        }

        // Show after the first generation completes
        genBtn.addEventListener('generate-done', () => {
            setTimeout(() => overlay.classList.remove('hidden'), 1000);
        }, { once: true });

        closeBtn.addEventListener('click', dismiss);
        dismissBtn.addEventListener('click', dismiss);
        linkBtn.addEventListener('click', dismiss);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) dismiss(); });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !overlay.classList.contains('hidden')) dismiss();
        });
    }
})();

// Screenshot helper — call window.takePreview() from the browser console
// Hides UI, renders at 1200×630 from the current camera angle, downloads preview.png
window.takePreview = function(width = 1200, height = 630) {
    // Save current state
    const savedW = renderer.domElement.width;
    const savedH = renderer.domElement.height;
    const savedAspect = camera.aspect;
    const savedPixelRatio = renderer.getPixelRatio();

    // Hide all UI elements
    const hiddenEls = [];
    for (const sel of ['#ui', '#topInfo', '#info', '#hoverInfo', '#helpBtn',
                        '#editToggle', '#refreshFab', '#rebuildFab', '#mobileViewSwitch',
                        '#buildOverlay', '#tutorialOverlay', '#exportOverlay', '#surveyOverlay', '#whatsNewOverlay']) {
        const el = document.querySelector(sel);
        if (el && el.style.display !== 'none') {
            hiddenEls.push({ el, prev: el.style.display });
            el.style.display = 'none';
        }
    }

    // Keep the current camera angle, just adjust aspect ratio for the output size
    camera.aspect = width / height;
    camera.updateProjectionMatrix();

    // Render at exact target size
    renderer.setPixelRatio(1);
    renderer.setSize(width, height);
    renderer.render(scene, camera);

    // Download
    const link = document.createElement('a');
    link.download = 'preview.png';
    link.href = renderer.domElement.toDataURL('image/png');
    link.click();

    // Restore everything
    renderer.setPixelRatio(savedPixelRatio);
    renderer.setSize(savedW / savedPixelRatio, savedH / savedPixelRatio);
    camera.aspect = savedAspect;
    camera.updateProjectionMatrix();
    for (const { el, prev } of hiddenEls) el.style.display = prev;
    renderer.render(scene, state.mapMode ? mapCamera : camera);
    console.log('preview.png downloaded!');
};

// Go! Check URL hash for a planet code. Without a code, stay on the static preview
// until the user clicks Generate.
const hashCode = location.hash.replace(/^#/, '').trim();
const hashParams = hashCode ? decodePlanetCode(hashCode) : null;
if (hashParams) {
    startupGenerationInProgress = true;
    pendingPlanetSeed = hashParams.seed;
    const map = paramsToSliderMap(hashParams);
    planetCodeRefreshSuppressed = true;
    try {
        for (const [id, val] of Object.entries(map)) {
            const el = document.getElementById(id);
            el.value = val;
            el.dispatchEvent(new Event('input'));
        }
    } finally {
        planetCodeRefreshSuppressed = false;
    }
    currentCode = hashCode.toLowerCase();
    seedInput.value = currentCode;
    updateLoadBtn();
    hideInitialPreview();
    showBuildOverlay();
    generate(hashParams.seed, hashParams.toggledIndices, onProgress, shouldSkipClimate());
} else {
    snapshotSliders();
    syncWorldReadyControls();
    updatePlanetCode(false);
    showInitialPreview();
    updateViewHint();
    if (hashCode) {
        seedInput.value = hashCode.toLowerCase();
        updateLoadBtn();
        seedError.classList.add('visible');
    }
}
animate();
