// Import page entry point — handles heightmap file upload, import dispatch,
// terrain sculpting reapply, and all visualization wiring.

import * as THREE from 'three';
import { renderer, scene, camera, ctrl, waterMesh, atmosMesh, starsMesh,
         mapCamera, updateMapCameraFrustum, mapCtrl, canvas,
         tickZoom, tickMapZoom, tickFreeCamera, setFreeCameraControls, recenterGlobeCamera,
         resetMapCameraView, setMapCameraZoom } from './scene.js';
import { state } from './state.js';
import { importHeightmap, reapplyViaWorker, computeClimateViaWorker } from './generate.js';
import { buildMesh, updateMeshColors, updateSuperPlateBorders, buildMapMesh, rebuildGrids, exportMap, exportWorldBundle, buildWindArrows, buildOceanCurrentArrows, updateKoppenHoverHighlight, updateMapKoppenHoverHighlight } from './planet-mesh.js';
import { detailFromSlider } from './detail-scale.js';
import { KOPPEN_CLASSES } from './koppen.js';
import { elevationToColor } from './color-map.js';
import { formatLatLabel, formatLonLabel, getMapProjectionLabel, getMapProjectionParams, mapPointToXyz,
         rotateMapProjectionParamsByDrag } from './map-projection.js';

// ─── File Upload ──────────────────────────────────────────────────

const fileInput = document.getElementById('heightmapFile');
const fileNameEl = document.getElementById('importFileName');
const previewCanvas = document.getElementById('importPreview');
const importDimsEl = document.getElementById('importDims');
const importBtn = document.getElementById('importBtn');

let storedGrayscale = null;
let storedWidth = 0;
let storedHeight = 0;

// ─── Default heightmap (Earth) ────────────────────────────────────

function loadImageAsHeightmap(img, displayName) {
    storedWidth = img.width;
    storedHeight = img.height;
    const offscreen = document.createElement('canvas');
    offscreen.width = img.width;
    offscreen.height = img.height;
    const offCtx = offscreen.getContext('2d');
    offCtx.drawImage(img, 0, 0);
    const previewW = Math.min(img.width, 400);
    const previewH = Math.round(previewW * img.height / img.width);
    previewCanvas.width = previewW;
    previewCanvas.height = previewH;
    const ctx = previewCanvas.getContext('2d');
    ctx.drawImage(img, 0, 0, previewW, previewH);
    previewCanvas.style.display = 'block';
    importDimsEl.textContent = `${img.width} × ${img.height}`;
    importDimsEl.style.display = 'block';
    const expectEl = document.getElementById('importExpect');
    if (expectEl) expectEl.style.display = 'block';
    const data = offCtx.getImageData(0, 0, img.width, img.height).data;
    const numPx = img.width * img.height;
    storedGrayscale = new Uint8Array(numPx);
    for (let i = 0; i < numPx; i++) {
        const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
        storedGrayscale[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
    }
    fileNameEl.textContent = displayName;
    importBtn.disabled = false;
}

(function loadDefaultHeightmap() {
    const img = new Image();
    img.onload = () => {
        loadImageAsHeightmap(img, '地球（默认）');
        importBtn.click();
    };
    img.src = 'assets/earth.png';
})();

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => loadImageAsHeightmap(img, file.name);
        img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
});

// ─── Detail slider ────────────────────────────────────────────────

const AUTO_CLIMATE_THRESHOLD = 300000;
const WARN_ORANGE = state.isTouchDevice ? 200000 : 640000;
const WARN_RED    = state.isTouchDevice ? 500000 : 1280000;

function shouldSkipClimate() {
    return detailFromSlider(+document.getElementById('sN').value) > AUTO_CLIMATE_THRESHOLD;
}

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

// Slider tooltip
function initSliderTooltip(slider) {
    const cg = slider.closest('.cg');
    if (!cg) return;
    cg.style.position = 'relative';
    const tip = document.createElement('div');
    tip.className = 'slider-tooltip';
    cg.appendChild(tip);
    function positionTip() {
        const pct = (+slider.value - +slider.min) / (+slider.max - +slider.min);
        tip.style.left = (pct * slider.offsetWidth) + 'px';
    }
    slider.addEventListener('pointerdown', () => {
        const vEl = document.getElementById(slider.id.replace('s', 'v'));
        if (vEl) tip.textContent = vEl.textContent;
        positionTip();
        tip.classList.add('visible');
    });
    slider.addEventListener('input', () => {
        const vEl = document.getElementById(slider.id.replace('s', 'v'));
        if (vEl) tip.textContent = vEl.textContent;
        positionTip();
    });
    const hide = () => tip.classList.remove('visible');
    slider.addEventListener('pointerup', hide);
    slider.addEventListener('pointercancel', hide);
}

// Wire sliders
for (const [s, v] of [['sN','vN'],['sTw','vTw'],['sS','vS'],['sGl','vGl'],['sHEr','vHEr'],['sTEr','vTEr'],['sRs','vRs'],['sTmp','vTmp'],['sPrc','vPrc']]) {
    const slider = document.getElementById(s);
    if (!slider) continue;
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
        } else {
            document.getElementById(v).textContent = e.target.value;
        }
        if (s === 'sTw' || s === 'sS' || s === 'sGl' || s === 'sHEr' || s === 'sTEr' || s === 'sRs') {
            markReapplyPending();
        }
    });
    // Climate sliders: recompute only on release (change), not every drag tick
    if (s === 'sTmp' || s === 'sPrc') {
        slider.addEventListener('change', () => {
            if (!state.curData) return;
            showBuildOverlay();
            computeClimateViaWorker(onProgress, () => {
                hideBuildOverlay();
                updateMeshColors();
                updateLegend(state.debugLayer);
            });
        });
    }
}

// ─── Reapply ──────────────────────────────────────────────────────

const reapplyBtn = document.getElementById('reapplyBtn');

function markReapplyPending() {
    if (!state.curData) return; // only after first import
    reapplyBtn.disabled = false;
    reapplyBtn.classList.add('ready');
}

function clearReapplyPending() {
    reapplyBtn.disabled = true;
    reapplyBtn.classList.remove('ready');
}

function reapplyPostProcessing() {
    const d = state.curData;
    if (!d || !d.prePostElev) return;
    const skipClimate = shouldSkipClimate();
    reapplyViaWorker(() => {
        reapplyBtn.classList.remove('spinning');
        if (skipClimate && CLIMATE_LAYERS.has(state.debugLayer)) {
            state.debugLayer = '';
            if (debugLayerEl) debugLayerEl.value = '';
            syncTabsToLayer('');
            updateMeshColors();
            updateLegend('');
        }
    }, skipClimate);
}

reapplyBtn.addEventListener('click', () => {
    if (reapplyBtn.disabled) return;
    clearReapplyPending();
    reapplyBtn.classList.add('spinning');
    reapplyPostProcessing();
});

// ─── Import button ────────────────────────────────────────────────

importBtn.addEventListener('click', () => {
    if (!storedGrayscale) return;
    importBtn.disabled = true;
    importBtn.textContent = '导入中\u2026';
    clearReapplyPending();
    buildWindArrows(null);
    buildOceanCurrentArrows(null);
    showBuildOverlay();
    // Collapse bottom sheet on mobile
    const ui = document.getElementById('ui');
    if (window.innerWidth <= 768 && ui) ui.classList.add('collapsed');
    // Copy grayscale since the buffer will be transferred
    const grayCopy = new Uint8Array(storedGrayscale);
    importHeightmap(grayCopy, storedWidth, storedHeight, onProgress, shouldSkipClimate());
});

// Generate-done handler (fired from generate.js after 'done' message)
const genBtn = document.getElementById('importBtn');
// The generate.js dispatches 'generate-done' on #generate, but for import page
// we use the same element ID pattern. Actually generate.js dispatches on
// document.getElementById('generate'). Since import page has no #generate,
// we need to listen on the actual element. Let me check...
// Actually, generate.js does: document.getElementById('generate').dispatchEvent(...)
// Since import page doesn't have a #generate element, we need a workaround.
// The cleanest approach: add a hidden #generate element, or listen differently.

// For now, we'll create a hidden generate button to receive the event
const hiddenGenBtn = document.createElement('button');
hiddenGenBtn.id = 'generate';
hiddenGenBtn.style.display = 'none';
document.body.appendChild(hiddenGenBtn);

hiddenGenBtn.addEventListener('generate-done', () => {
    hideBuildOverlay();
    importBtn.disabled = false;
    importBtn.textContent = '导入';
    state.importedHeightmap = true;
    // Update info text
    updateViewHint();
    // Sync view
    if (!state.climateComputed && CLIMATE_LAYERS.has(state.debugLayer)) {
        state.debugLayer = '';
        if (debugLayerEl) debugLayerEl.value = '';
        syncTabsToLayer('');
        updateMeshColors();
    }
    syncTabsToLayer(state.debugLayer);
    if (debugLayerEl) debugLayerEl.value = state.debugLayer;
    updateLegend(state.debugLayer);
    // Rebuild arrows if needed
    const v = state.debugLayer;
    const isWindLayer = v === 'pressureSummer' || v === 'pressureWinter' ||
                        v === 'windSpeedSummer' || v === 'windSpeedWinter';
    const isOceanLayer = v === 'oceanCurrentSummer' || v === 'oceanCurrentWinter';
    if (isWindLayer) buildWindArrows(v.includes('Winter') ? 'winter' : 'summer');
    else if (isOceanLayer) buildOceanCurrentArrows(v.includes('Winter') ? 'winter' : 'summer');
});

// ─── Climate layers ───────────────────────────────────────────────

const CLIMATE_LAYERS = new Set([
    'pressureSummer', 'pressureWinter',
    'windSpeedSummer', 'windSpeedWinter',
    'oceanCurrentSummer', 'oceanCurrentWinter',
    'precipSummer', 'precipWinter',
    'rainShadowSummer', 'rainShadowWinter',
    'tempSummer', 'tempWinter',
    'koppen', 'biome', 'continentality', 'tempContinentality'
]);

// ─── Visualization (debug layers, tabs, legend) ───────────────────

const mapTabs = document.getElementById('mapTabs');
const vizLegend = document.getElementById('vizLegend');
const debugLayerEl = document.getElementById('debugLayer');

function switchVisualization(layer) {
    if (CLIMATE_LAYERS.has(layer) && !state.climateComputed) {
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
    const isWindLayer = layer === 'pressureSummer' || layer === 'pressureWinter' ||
                        layer === 'windSpeedSummer' || layer === 'windSpeedWinter';
    const isOceanLayer = layer === 'oceanCurrentSummer' || layer === 'oceanCurrentWinter';
    if (isOceanLayer) {
        buildWindArrows(null);
        buildOceanCurrentArrows(layer.includes('Winter') ? 'winter' : 'summer');
    } else if (isWindLayer) {
        buildOceanCurrentArrows(null);
        buildWindArrows(layer.includes('Winter') ? 'winter' : 'summer');
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
    const mvs = document.getElementById('mobileViewSwitch');
    if (mvs && [...mvs.options].some(o => o.value === layer)) {
        mvs.value = layer;
    }
}

mapTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.map-tab');
    if (!tab) return;
    const layer = tab.dataset.layer;
    mapTabs.querySelectorAll('.map-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    if (debugLayerEl) debugLayerEl.value = layer;
    const mvs = document.getElementById('mobileViewSwitch');
    if (mvs) mvs.value = layer;
    switchVisualization(layer);
});

const mobileViewSwitch = document.getElementById('mobileViewSwitch');
if (mobileViewSwitch) {
    mobileViewSwitch.addEventListener('change', (e) => {
        const layer = e.target.value;
        syncTabsToLayer(layer);
        if (debugLayerEl) debugLayerEl.value = layer;
        switchVisualization(layer);
    });
}

if (debugLayerEl) {
    debugLayerEl.addEventListener('change', (e) => {
        const layer = e.target.value;
        syncTabsToLayer(layer);
        switchVisualization(layer);
    });
}

// ─── Legend ────────────────────────────────────────────────────────

const KOPPEN_DESCRIPTIONS = {
    Af:  '热带雨林气候 - 终年炎热湿润。',
    Am:  '热带季风气候 - 短暂旱季后有强季风降雨。',
    Aw:  '热带稀树草原气候 - 干湿季分明。',
    BWh: '热带沙漠气候 - 极端干燥且夏季酷热。',
    BWk: '冷沙漠气候 - 干旱且冬季寒冷。',
    BSh: '热带草原气候 - 半干旱草原，夏季炎热。',
    BSk: '冷草原气候 - 半干旱且冬季寒冷。',
    Cfa: '湿润亚热带气候 - 夏季炎热潮湿，冬季温和。',
    Cfb: '海洋性气候 - 全年温和，夏季凉爽，降雨频繁。',
    Cfc: '副极地海洋性气候 - 全年凉爽，夏季短。',
    Csa: '夏热地中海气候 - 夏季干热，冬季温和多雨。',
    Csb: '夏暖地中海气候 - 夏季干暖，冬季温和多雨。',
    Csc: '夏凉地中海气候 - 夏季凉爽干燥，冬季温和多雨。',
    Cwa: '季风型湿润亚热带气候 - 温暖且冬季干燥。',
    Cwb: '亚热带高原气候 - 温和且冬季干燥。',
    Cwc: '冷凉亚热带高原气候 - 凉爽且冬季干燥。',
    Dfa: '夏热大陆性气候 - 夏季炎热，冬季寒冷多雪。',
    Dfb: '夏暖大陆性气候 - 夏季温暖，冬季寒冷。',
    Dfc: '亚寒带气候 - 冬季漫长寒冷，夏季短暂凉爽。',
    Dfd: '极寒亚寒带气候 - 地球上最严寒的冬季。',
    Dsa: '夏热大陆性干夏气候 - 夏季干热，冬季寒冷。',
    Dsb: '夏暖大陆性干夏气候 - 夏季干暖，冬季寒冷。',
    Dsc: '亚寒带干夏气候 - 夏季凉爽干燥，冬季严寒。',
    Dsd: '极寒亚寒带干夏气候 - 极罕见，兼具严寒和干夏。',
    Dwa: '夏热大陆性季风气候 - 夏季湿热，冬季干冷。',
    Dwb: '夏暖大陆性季风气候 - 夏季温暖多雨，冬季干冷。',
    Dwc: '亚寒带季风气候 - 夏季短暂多雨，冬季漫长严寒。',
    Dwd: '极寒亚寒带季风气候 - 极寒且冬季最干。',
    ET:  '苔原气候 - 多年冻土，只有最暖月高于 0°C。',
    EF:  '冰原气候 - 永久冰盖，全年不高于 0°C。',
};

function updateLegend(layer) {
    if (!vizLegend) return;
    if (layer === '' || !layer) {
        const stops = [
            { e: -0.50 }, { e: -0.25 }, { e: -0.05 }, { e: 0.00 },
            { e: 0.03 }, { e: 0.15 }, { e: 0.35 }, { e: 0.55 }, { e: 0.80 }
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
        let html = '<div class="legend-koppen-header"><a href="https://en.wikipedia.org/wiki/K%C3%B6ppen_climate_classification" target="_blank" rel="noopener">柯本气候分类</a></div>';
        html += '<div class="legend-koppen">';
        for (let i = 1; i < KOPPEN_CLASSES.length; i++) {
            const k = KOPPEN_CLASSES[i];
            const [r, g, b] = k.color;
            const hex = `rgb(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)})`;
            html += `<div class="legend-koppen-item" data-code="${k.code}"><span class="legend-koppen-swatch" style="background:${hex}"></span>${k.code}</div>`;
        }
        html += '<div class="legend-koppen-tooltip" id="koppenTip"></div>';
        html += '</div>';
        vizLegend.innerHTML = html;
        const tipEl = document.getElementById('koppenTip');
        const container = vizLegend.querySelector('.legend-koppen');
        vizLegend.querySelectorAll('.legend-koppen-item').forEach(item => {
            item.addEventListener('mouseenter', () => {
                const code = item.dataset.code;
                tipEl.textContent = KOPPEN_DESCRIPTIONS[code] || '';
                tipEl.classList.add('visible');
                const itemRect = item.getBoundingClientRect();
                const containerRect = container.getBoundingClientRect();
                const tipWidth = 240;
                let left = itemRect.left - containerRect.left + itemRect.width / 2 - tipWidth / 2;
                left = Math.max(0, Math.min(left, containerRect.width - tipWidth));
                tipEl.style.left = left + 'px';
                tipEl.style.bottom = (containerRect.bottom - itemRect.top + 6) + 'px';
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
        const biomeStops = [
            { color: [0.82,0.72,0.50], label: '沙漠' },
            { color: [0.72,0.62,0.30], label: '草原' },
            { color: [0.42,0.50,0.18], label: '稀树草原' },
            { color: [0.12,0.38,0.10], label: '森林' },
            { color: [0.06,0.22,0.08], label: '针叶林' },
            { color: [0.35,0.32,0.22], label: '苔原' },
            { color: [0.78,0.80,0.84], label: '冰原' },
        ];
        const biomeColors = biomeStops.map(s => `rgb(${Math.round(s.color[0]*255)},${Math.round(s.color[1]*255)},${Math.round(s.color[2]*255)})`);
        const biomePcts = biomeStops.map((_, i) => Math.round(i / (biomeStops.length - 1) * 100));
        const biomeGrad = biomeColors.map((c, i) => `${c} ${biomePcts[i]}%`).join(', ');
        vizLegend.innerHTML = `<div class="legend-gradient" style="background:linear-gradient(to right,${biomeGrad})"></div>` +
            `<div class="legend-labels"><span>${biomeStops[0].label}</span><span>${biomeStops[3].label}</span><span>${biomeStops[6].label}</span></div>`;
    } else if (layer === 'rainShadowSummer' || layer === 'rainShadowWinter') {
        vizLegend.innerHTML = `<div class="legend-gradient" style="background:linear-gradient(to right,rgb(230,51,33) 0%,rgb(140,140,148) 50%,rgb(38,102,243) 100%)"></div>` +
            `<div class="legend-labels"><span>雨影</span><span>中性</span><span>迎风</span></div>`;
    } else if (layer === 'landheightmap') {
        vizLegend.innerHTML = `<div class="legend-gradient" style="background:linear-gradient(to right,#000 0%,#fff 100%)"></div>` +
            `<div class="legend-labels"><span>海洋 / 海平面</span><span>峰顶</span></div>`;
    } else {
        vizLegend.innerHTML = '';
    }
}

// ─── Build overlay ────────────────────────────────────────────────

const buildOverlay  = document.getElementById('buildOverlay');
const buildBarFill  = document.getElementById('buildBarFill');
const buildBarLabel = document.getElementById('buildBarLabel');
let overlayActive = false;
let buildOverlayHideTimer = 0;

function onProgress(pct, label) {
    if (!overlayActive) return;
    if (buildBarFill) buildBarFill.style.transform = 'scaleX(' + (pct / 100) + ')';
    if (buildBarLabel) buildBarLabel.textContent = label;
}

function showBuildOverlay() {
    if (!buildBarFill || !buildOverlay) return;
    if (buildOverlayHideTimer) {
        clearTimeout(buildOverlayHideTimer);
        buildOverlayHideTimer = 0;
    }
    buildBarFill.style.transition = 'none';
    buildBarFill.style.transform = 'scaleX(0)';
    buildBarLabel.textContent = '';
    buildBarFill.offsetWidth;
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
            buildOverlay.classList.remove('initial');
        }
    }, 500);
}

// ─── View mode ────────────────────────────────────────────────────

document.getElementById('chkWire').addEventListener('change', buildMesh);

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
const MAP_VIEW_DEFAULTS = { projection: 'equirectangular', lon: 0, lat: 0, rotation: 0, zoom: 1 };
const MAP_DRAG_MIN_DISTANCE = 4;
const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;
let mapProjectionRefreshTimer = 0;
let mapProjectionRefreshToken = 0;
let mapZoomSyncing = false;

function rebuildMapProjectionView() {
    if (!state.mapMode) return;
    buildMapMesh();
    const layer = state.debugLayer;
    const isWind = layer === 'pressureSummer' || layer === 'pressureWinter' ||
                   layer === 'windSpeedSummer' || layer === 'windSpeedWinter';
    const isOcean = layer === 'oceanCurrentSummer' || layer === 'oceanCurrentWinter';
    if (isWind) buildWindArrows(layer.includes('Winter') ? 'winter' : 'summer');
    if (isOcean) buildOceanCurrentArrows(layer.includes('Winter') ? 'winter' : 'summer');
    updateViewHint();
}

function rebuildMapProjectionViewWithOverlay(label = '正在重绘地图投影…') {
    if (!state.mapMode) return;
    if (mapProjectionRefreshTimer) {
        clearTimeout(mapProjectionRefreshTimer);
        mapProjectionRefreshTimer = 0;
    }
    const token = ++mapProjectionRefreshToken;
    showBuildOverlay();
    onProgress(5, label);
    setTimeout(() => {
        if (token !== mapProjectionRefreshToken) return;
        if (!state.mapMode) { hideBuildOverlay(); return; }
        try {
            onProgress(35, '正在构建地图网格…');
            rebuildMapProjectionView();
            onProgress(100, '地图投影已更新');
        } catch (err) {
            console.error('[MapProjection] Failed to rebuild projected map view:', err);
            onProgress(100, '地图投影更新失败');
        } finally {
            hideBuildOverlay();
        }
    }, 50);
}

function scheduleMapProjectionRefresh({ overlay = true, debounce = true, label = '正在调整地图视角…' } = {}) {
    if (!state.mapMode) return;
    if (mapProjectionRefreshTimer) {
        if (!debounce) return;
        clearTimeout(mapProjectionRefreshTimer);
    }
    mapProjectionRefreshTimer = setTimeout(() => {
        mapProjectionRefreshTimer = 0;
        if (overlay) rebuildMapProjectionViewWithOverlay(label);
        else rebuildMapProjectionView();
    }, overlay ? 180 : 80);
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

function setMapCenterControls(lon, lat, { refresh = 'schedule', overlay = true } = {}) {
    const snappedLon = snapMapCenter(wrapMapCenterLon(lon), sMapCenterLon);
    const snappedLat = snapMapCenter(lat, sMapCenterLat);
    sMapCenterLon.value = snappedLon;
    vMapCenterLon.textContent = formatLonLabel(snappedLon);
    state.mapCenterLon = snappedLon * Math.PI / 180;
    sMapCenterLat.value = snappedLat;
    vMapCenterLat.textContent = formatLatLabel(snappedLat);
    state.mapCenterLat = snappedLat * Math.PI / 180;
    if (refresh === 'immediate') rebuildMapProjectionViewWithOverlay('正在调整地图视角…');
    else if (refresh === 'schedule') scheduleMapProjectionRefresh({ overlay, debounce: overlay });
}

function setMapRotationControls(rotation, { refresh = 'schedule', overlay = true } = {}) {
    const snappedRotation = snapMapCenter(wrapMapCenterLon(rotation), sMapRotation);
    sMapRotation.value = snappedRotation;
    vMapRotation.textContent = `${snappedRotation}°`;
    state.mapRotation = snappedRotation * DEG_TO_RAD;
    if (refresh === 'immediate') rebuildMapProjectionViewWithOverlay('正在调整地图倾角…');
    else if (refresh === 'schedule') scheduleMapProjectionRefresh({ overlay, debounce: overlay });
}

function setMapOrientationControls(lon, lat, rotation, { refresh = 'schedule', overlay = true } = {}) {
    setMapCenterControls(lon, lat, { refresh: 'none' });
    setMapRotationControls(rotation, { refresh: 'none' });
    if (refresh === 'immediate') rebuildMapProjectionViewWithOverlay('正在调整地图视角…');
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
    if (sMapProjection) {
        sMapProjection.value = MAP_VIEW_DEFAULTS.projection;
        state.mapProjection = MAP_VIEW_DEFAULTS.projection;
    }
    resetMapCameraView();
    setMapOrientationControls(MAP_VIEW_DEFAULTS.lon, MAP_VIEW_DEFAULTS.lat, MAP_VIEW_DEFAULTS.rotation, { refresh: 'none' });
    setMapZoomControls(MAP_VIEW_DEFAULTS.zoom, { immediate: true });
    rebuildMapProjectionViewWithOverlay('正在重置地图视角…');
    updateViewHint();
}

if (sMapProjection) {
    sMapProjection.addEventListener('change', () => {
        state.mapProjection = sMapProjection.value;
        rebuildMapProjectionViewWithOverlay('正在切换地图投影…');
    });
}

sMapCenterLon.addEventListener('input', () => {
    setMapCenterControls(+sMapCenterLon.value, +sMapCenterLat.value);
});

sMapCenterLon.addEventListener('change', () => {
    rebuildMapProjectionViewWithOverlay('正在调整地图视角…');
});

sMapCenterLat.addEventListener('input', () => {
    setMapCenterControls(+sMapCenterLon.value, +sMapCenterLat.value);
});

sMapCenterLat.addEventListener('change', () => {
    rebuildMapProjectionViewWithOverlay('正在调整地图视角…');
});

if (sMapRotation) {
    sMapRotation.addEventListener('input', () => {
        setMapRotationControls(+sMapRotation.value);
    });

    sMapRotation.addEventListener('change', () => {
        rebuildMapProjectionViewWithOverlay('正在调整地图倾角…');
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
        canvas.classList.remove('map-center-dragging');
        try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
        if (mapProjectionRefreshTimer) {
            clearTimeout(mapProjectionRefreshTimer);
            mapProjectionRefreshTimer = 0;
        }
        if (moved) rebuildMapProjectionViewWithOverlay('正在调整地图视角…');
        e.preventDefault();
        e.stopImmediatePropagation();
    }

    canvas.addEventListener('pointerup', finishDrag, true);
    canvas.addEventListener('pointercancel', finishDrag, true);
}

initMapCenterDrag();

function updateViewHint() {
    const globeHint = state.isTouchDevice
        ? '拖拽旋转 · 双指缩放'
        : '拖拽旋转 · 滚轮缩放';
    const hint = state.mapMode
        ? `拖拽旋转投影 · 滚轮缩放 · ${getMapProjectionLabel()} 投影`
        : state.freeCameraMode
            ? 'WASD 移动 · Q/E 上下 · 按住鼠标右键转动视角'
            : globeHint;
    for (const id of ['topInfo', 'info']) {
        const el = document.getElementById(id);
        if (el) el.textContent = hint;
    }
}

// Globe / Free Camera / Map toggle
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
        if (!state.mapMesh) {
            showBuildOverlay();
            onProgress(0, '正在构建地图网格\u2026');
            setTimeout(() => {
                buildMapMesh();
                if (state.mapMesh) state.mapMesh.visible = true;
                hideBuildOverlay();
            }, 50);
        }
        if (state.mapMesh) state.mapMesh.visible = true;
        if (state.mapGridMesh) state.mapGridMesh.visible = state.gridEnabled;
        if (state.globeGridMesh) state.globeGridMesh.visible = false;
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
        if (state.mapMesh) state.mapMesh.visible = false;
        if (state.mapGridMesh) state.mapGridMesh.visible = false;
        if (state.globeGridMesh) state.globeGridMesh.visible = state.gridEnabled;
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
        waterMesh.visible = !state.debugLayer;
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

// ─── Export modal ─────────────────────────────────────────────────

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
        overlay.classList.remove('hidden');
        updateDims();
        renderExportDebugOptions();
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

// ─── Sidebar toggle + bottom sheet ────────────────────────────────

const sidebarToggle = document.getElementById('sidebarToggle');
const uiPanel = document.getElementById('ui');
const isMobileLayout = () => window.innerWidth <= 768;

if (isMobileLayout()) {
    uiPanel.classList.add('collapsed');
}

sidebarToggle.addEventListener('click', () => {
    const collapsed = uiPanel.classList.toggle('collapsed');
    sidebarToggle.innerHTML = collapsed ? '\u00BB' : '\u00AB';
    sidebarToggle.title = collapsed ? '显示面板' : '收起面板';
});

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
    function getCollapsedY() { return uiPanel.offsetHeight - 60; }
    function applyTransform() {
        if (pendingY !== null) { uiPanel.style.transform = `translateY(${pendingY}px)`; pendingY = null; }
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
        dragging = true; didDrag = false;
        startY = e.clientY; lastY = e.clientY;
        lastTime = performance.now(); velocity = 0;
        startTransform = uiPanel.classList.contains('collapsed') ? getTranslateY() : 0;
        uiPanel.style.transition = 'none';
        uiPanel.classList.add('dragging');
    });
    handle.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const y = e.clientY;
        const now = performance.now();
        const dt = now - lastTime;
        if (dt > 0) velocity = (y - lastY) / dt;
        lastY = y; lastTime = now;
        const dy = y - startY;
        if (Math.abs(dy) > 5) didDrag = true;
        const collapsedY = getCollapsedY();
        scheduleTransform(Math.max(0, Math.min(collapsedY, startTransform + dy)));
    });
    handle.addEventListener('pointerup', (e) => {
        if (!dragging) return;
        handle.releasePointerCapture(e.pointerId);
        cleanup();
        const curY = getTranslateY();
        const collapsedY = getCollapsedY();
        const progress = collapsedY > 0 ? 1 - curY / collapsedY : 0;
        if (velocity > 0.3 || (velocity > -0.3 && progress < 0.3)) {
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
    handle.addEventListener('click', () => {
        if (!isMobileLayout()) return;
        if (didDrag) { didDrag = false; return; }
        uiPanel.classList.toggle('collapsed');
    });
})();

// ─── Mobile info text ─────────────────────────────────────────────

if (state.isTouchDevice) {
    const infoEl = document.getElementById('info');
    if (infoEl) infoEl.textContent = '导入高度图以开始';
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

// ─── Orientation change ───────────────────────────────────────────

window.addEventListener('orientationchange', () => {
    setTimeout(() => {
        camera.aspect = innerWidth / innerHeight;
        camera.updateProjectionMatrix();
        updateMapCameraFrustum();
        renderer.setSize(innerWidth, innerHeight);
    }, 100);
});

// ─── Animation loop ───────────────────────────────────────────────

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

// ─── Resize handler ───────────────────────────────────────────────

window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    updateMapCameraFrustum();
    renderer.setSize(innerWidth, innerHeight);
});

// ─── Hover info (analytical ray-sphere, no mesh raycasting) ───────

(function initHoverInfo() {
    const hoverEl = document.getElementById('hoverInfo');
    if (!hoverEl) return;
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    const _inverseMatrix = new THREE.Matrix4();
    const _localRay = new THREE.Ray();

    const HOVER_INTERVAL = 50; // ms throttle
    let lastHoverTime = 0;
    let lastRegion = -1;

    /** Find nearest region to a unit-sphere direction (max dot product). */
    function findNearestRegion(nx, ny, nz) {
        const { mesh, r_xyz } = state.curData;
        const N = mesh.numRegions;
        let bestDot = -2, bestR = -1;
        for (let r = 0; r < N; r++) {
            const dot = nx * r_xyz[3 * r] + ny * r_xyz[3 * r + 1] + nz * r_xyz[3 * r + 2];
            if (dot > bestDot) { bestDot = dot; bestR = r; }
        }
        return bestR;
    }

    function getHitRegionGlobe(e) {
        if (!state.planetMesh) return -1;
        const rect = canvas.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        _inverseMatrix.copy(state.planetMesh.matrixWorld).invert();
        _localRay.copy(raycaster.ray).applyMatrix4(_inverseMatrix);
        const ox = _localRay.origin.x, oy = _localRay.origin.y, oz = _localRay.origin.z;
        const dx = _localRay.direction.x, dy = _localRay.direction.y, dz = _localRay.direction.z;
        const R = 1.08;
        const b = 2 * (ox * dx + oy * dy + oz * dz);
        const c = ox * ox + oy * oy + oz * oz - R * R;
        const disc = b * b - 4 * c;
        if (disc < 0) return -1;
        const t = (-b - Math.sqrt(disc)) * 0.5;
        if (t < 0) return -1;
        const hx = ox + t * dx, hy = oy + t * dy, hz = oz + t * dz;
        const len = Math.sqrt(hx * hx + hy * hy + hz * hz) || 1;
        return findNearestRegion(hx / len, hy / len, hz / len);
    }

    function getHitRegionMap(e) {
        if (!state.mapMesh) return -1;
        const rect = canvas.getBoundingClientRect();
        mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(mouse, mapCamera);
        const o = raycaster.ray.origin, d = raycaster.ray.direction;
        if (Math.abs(d.z) < 1e-10) return -1;
        const t = -o.z / d.z;
        const wx = o.x + t * d.x, wy = o.y + t * d.y;
        const xyz = mapPointToXyz(wx, wy);
        return xyz ? findNearestRegion(xyz[0], xyz[1], xyz[2]) : -1;
    }

    function updateHoverInfo(e) {
        if (!state.curData) return;
        const now = performance.now();
        if (now - lastHoverTime < HOVER_INTERVAL) return;
        lastHoverTime = now;

        const r = state.mapMode ? getHitRegionMap(e) : getHitRegionGlobe(e);
        if (r === lastRegion) return; // no change
        lastRegion = r;

        if (r < 0) { hoverEl.style.display = 'none'; return; }
        showRegionInfo(r);
    }

    function showRegionInfo(r) {
        const d = state.curData;
        if (!d || r < 0 || r >= d.mesh.numRegions) { hoverEl.style.display = 'none'; return; }
        const x = d.r_xyz[3*r], y = d.r_xyz[3*r+1], z = d.r_xyz[3*r+2];
        const lat = Math.asin(Math.max(-1, Math.min(1, y))) * 180 / Math.PI;
        const lon = Math.atan2(x, z) * 180 / Math.PI;
        const elev = d.r_elevation[r];
        const heightKm = elev <= 0 ? (elev * 10).toFixed(1) : (6 * elev * elev).toFixed(1);
        const isOcean = elev <= 0;

        let html = `<span class="hi-label">高程</span> ${heightKm} km（${isOcean ? '海洋' : '陆地'}）<br>`;
        html += `<span class="hi-label">坐标</span> ${Math.abs(lat).toFixed(1)}\u00b0${lat >= 0 ? '北' : '南'}, ${Math.abs(lon).toFixed(1)}\u00b0${lon >= 0 ? '东' : '西'}`;

        if (d.r_temperature_summer && d.r_precip_summer) {
            const ts = d.r_temperature_summer[r], tw = d.r_temperature_winter[r];
            const ps = d.r_precip_summer[r], pw = d.r_precip_winter[r];
            const tAvg = ((ts + tw) / 2).toFixed(1);
            const pTotal = Math.round(ps + pw);
            html += `<br><span class="hi-label">温度</span> ${tAvg}\u00b0C 平均（夏季 ${ts.toFixed(1)}，冬季 ${tw.toFixed(1)}）`;
            html += `<br><span class="hi-label">降水</span> ${pTotal} mm/年`;
        }

        if (d.debugLayers?.koppen) {
            const kIdx = d.debugLayers.koppen[r];
            if (kIdx > 0 && kIdx < KOPPEN_CLASSES.length) {
                const k = KOPPEN_CLASSES[kIdx];
                html += `<br><span class="hi-label">气候</span> ${k.code} \u2014 ${k.name}`;
            }
        }

        hoverEl.innerHTML = html;
        hoverEl.style.display = 'block';
    }

    canvas.addEventListener('mousemove', updateHoverInfo);
    canvas.addEventListener('mouseleave', () => { lastRegion = -1; hoverEl.style.display = 'none'; });
})();

// ─── Screenshot helper ────────────────────────────────────────────

window.takePreview = function(width = 1200, height = 630) {
    const savedW = renderer.domElement.width;
    const savedH = renderer.domElement.height;
    const savedAspect = camera.aspect;
    const savedPixelRatio = renderer.getPixelRatio();

    const hiddenEls = [];
    for (const sel of ['#ui', '#topInfo', '#info', '#hoverInfo', '#helpBtn',
                        '#editToggle', '#refreshFab', '#rebuildFab', '#mobileViewSwitch',
                        '#buildOverlay', '#tutorialOverlay', '#exportOverlay', '#whatsNewOverlay']) {
        const el = document.querySelector(sel);
        if (el && el.style.display !== 'none') {
            hiddenEls.push({ el, prev: el.style.display });
            el.style.display = 'none';
        }
    }

    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setPixelRatio(1);
    renderer.setSize(width, height);
    renderer.render(scene, state.mapMode ? mapCamera : camera);

    const link = document.createElement('a');
    link.download = 'preview.png';
    link.href = renderer.domElement.toDataURL('image/png');
    link.click();

    renderer.setPixelRatio(savedPixelRatio);
    renderer.setSize(savedW / savedPixelRatio, savedH / savedPixelRatio);
    camera.aspect = savedAspect;
    camera.updateProjectionMatrix();
    for (const { el, prev } of hiddenEls) el.style.display = prev;
    renderer.render(scene, state.mapMode ? mapCamera : camera);
    console.log('preview.png downloaded!');
};

// ─── Start ────────────────────────────────────────────────────────

animate();
