// Three.js scene setup: renderer, cameras, controls, lights, atmosphere, water, stars.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const canvas   = document.getElementById('canvas');
export const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

export const scene  = new THREE.Scene();
scene.background = new THREE.Color(0x030308);

export const camera = new THREE.PerspectiveCamera(50, innerWidth/innerHeight, 0.1, 200);
camera.position.set(0, 0.4, 2.8);

export const ctrl = new OrbitControls(camera, canvas);
ctrl.enableDamping = true; ctrl.dampingFactor = 0.06;
ctrl.enablePan = false;
ctrl.minDistance = 1.4; ctrl.maxDistance = 8;
ctrl.enableZoom = false; // disable built-in zoom; custom handler below

let _freeCameraEnabled = false;
let _freeLookActive = false;
let _freeYaw = 0;
let _freePitch = 0;
let _freeLastTick = performance.now();
const _freeKeys = new Set();
const _freeEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const _freeForward = new THREE.Vector3();
const _freeRight = new THREE.Vector3();
const _freeMove = new THREE.Vector3();
const FREE_MOVE_SPEED = 1.35;
const FREE_LOOK_SENSITIVITY = 0.003;
const FREE_PITCH_LIMIT = Math.PI / 2 - 0.02;

export function setFreeCameraControls(enabled) {
    _freeCameraEnabled = enabled;
    _freeLookActive = false;
    _freeKeys.clear();
    _freeLastTick = performance.now();
    if (enabled) {
        _freeEuler.setFromQuaternion(camera.quaternion, 'YXZ');
        _freePitch = _freeEuler.x;
        _freeYaw = _freeEuler.y;
    }
}

// Smooth zoom: wheel sets a target distance, each frame lerps toward it
let _zoomTarget = camera.position.distanceTo(ctrl.target);
const ZOOM_STEP   = 0.92;   // multiplier per tick (lower = faster zoom)
const ZOOM_SMOOTH = 0.12;   // lerp speed per frame (higher = snappier)

export function recenterGlobeCamera() {
    const v = new THREE.Vector3().subVectors(camera.position, ctrl.target);
    ctrl.target.set(0, 0, 0);
    camera.position.copy(ctrl.target).add(v);
    _zoomTarget = THREE.MathUtils.clamp(v.length(), ctrl.minDistance, ctrl.maxDistance);
    ctrl.update();
}

canvas.addEventListener('wheel', (e) => {
    if (!ctrl.enabled) return;
    e.preventDefault();
    const dir = Math.sign(e.deltaY);
    _zoomTarget *= dir > 0 ? 1 / ZOOM_STEP : ZOOM_STEP;
    _zoomTarget = THREE.MathUtils.clamp(_zoomTarget, ctrl.minDistance, ctrl.maxDistance);
}, { passive: false });

// Pinch-to-zoom for globe (touch)
let _pinchDist = 0;
canvas.addEventListener('touchstart', (e) => {
    if (!ctrl.enabled || e.touches.length !== 2) { _pinchDist = 0; return; }
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    _pinchDist = Math.sqrt(dx * dx + dy * dy);
}, { passive: true });

canvas.addEventListener('touchmove', (e) => {
    if (!ctrl.enabled || e.touches.length !== 2 || _pinchDist === 0) return;
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const ratio = _pinchDist / dist;
    _zoomTarget *= ratio;
    _zoomTarget = THREE.MathUtils.clamp(_zoomTarget, ctrl.minDistance, ctrl.maxDistance);
    _pinchDist = dist;
}, { passive: true });

canvas.addEventListener('touchend', () => { _pinchDist = 0; }, { passive: true });

export function tickZoom() {
    const v = new THREE.Vector3().subVectors(camera.position, ctrl.target);
    const cur = v.length();
    const next = THREE.MathUtils.lerp(cur, _zoomTarget, ZOOM_SMOOTH);
    if (Math.abs(next - cur) < 0.0001) return;
    v.setLength(next);
    camera.position.copy(ctrl.target).add(v);
}

function isTypingTarget(target) {
    if (!target) return false;
    const tag = target.tagName;
    return target.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function applyFreeLook() {
    _freeEuler.set(_freePitch, _freeYaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(_freeEuler);
}

window.addEventListener('keydown', (e) => {
    if (!_freeCameraEnabled || isTypingTarget(e.target)) return;
    const key = e.key.toLowerCase();
    if (!'wasdqe'.includes(key)) return;
    e.preventDefault();
    _freeKeys.add(key);
});

window.addEventListener('keyup', (e) => {
    _freeKeys.delete(e.key.toLowerCase());
});

window.addEventListener('blur', () => {
    _freeKeys.clear();
    _freeLookActive = false;
});

canvas.addEventListener('contextmenu', (e) => {
    if (_freeCameraEnabled) e.preventDefault();
});

canvas.addEventListener('pointerdown', (e) => {
    if (!_freeCameraEnabled || e.button !== 2) return;
    e.preventDefault();
    _freeLookActive = true;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
});

canvas.addEventListener('pointermove', (e) => {
    if (!_freeCameraEnabled || !_freeLookActive) return;
    e.preventDefault();
    _freeYaw -= e.movementX * FREE_LOOK_SENSITIVITY;
    _freePitch -= e.movementY * FREE_LOOK_SENSITIVITY;
    _freePitch = THREE.MathUtils.clamp(_freePitch, -FREE_PITCH_LIMIT, FREE_PITCH_LIMIT);
    applyFreeLook();
});

function stopFreeLook(e) {
    if (!_freeLookActive) return;
    _freeLookActive = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
}

canvas.addEventListener('pointerup', stopFreeLook);
canvas.addEventListener('pointercancel', stopFreeLook);

export function tickFreeCamera() {
    if (!_freeCameraEnabled) return;

    const now = performance.now();
    const dt = Math.min(0.05, Math.max(0, (now - _freeLastTick) / 1000));
    _freeLastTick = now;

    _freeMove.set(0, 0, 0);
    camera.getWorldDirection(_freeForward);
    _freeRight.set(1, 0, 0).applyQuaternion(camera.quaternion);

    if (_freeKeys.has('w')) _freeMove.add(_freeForward);
    if (_freeKeys.has('s')) _freeMove.sub(_freeForward);
    if (_freeKeys.has('d')) _freeMove.add(_freeRight);
    if (_freeKeys.has('a')) _freeMove.sub(_freeRight);
    if (_freeKeys.has('e')) _freeMove.y += 1;
    if (_freeKeys.has('q')) _freeMove.y -= 1;

    if (_freeMove.lengthSq() === 0) return;
    _freeMove.normalize();
    camera.position.addScaledVector(_freeMove, FREE_MOVE_SPEED * dt);
}

scene.add(new THREE.AmbientLight(0xaabbcc, 3.5));
export const sun = new THREE.DirectionalLight(0xfff8ee, 1.5);
sun.position.set(5, 3, 4);
scene.add(sun);

// Stars
export let starsMesh;
{ const g=new THREE.BufferGeometry(),p=[];
  for(let i=0;i<3000;i++){const th=Math.random()*Math.PI*2,ph=Math.acos(2*Math.random()-1),r=40+Math.random()*30;
    p.push(r*Math.sin(ph)*Math.cos(th),r*Math.sin(ph)*Math.sin(th),r*Math.cos(ph));}
  g.setAttribute('position',new THREE.Float32BufferAttribute(p,3));
  starsMesh = new THREE.Points(g,new THREE.PointsMaterial({color:0xffffff,size:0.08}));
  scene.add(starsMesh); }

// Atmosphere
const atmosMat = new THREE.ShaderMaterial({
    uniforms:{c:{value:new THREE.Color(0.35,0.6,1.0)}},
    vertexShader:`varying vec3 vN,vP;void main(){vN=normalize(normalMatrix*normal);vP=(modelViewMatrix*vec4(position,1)).xyz;gl_Position=projectionMatrix*vec4(vP,1);}`,
    fragmentShader:`uniform vec3 c;varying vec3 vN,vP;void main(){float r=1.0-max(0.0,dot(normalize(-vP),vN));gl_FragColor=vec4(c,pow(r,3.5)*0.55);}`,
    transparent:true,side:THREE.FrontSide,depthWrite:false
});
export const atmosMesh = new THREE.Mesh(new THREE.SphereGeometry(1.12,64,64), atmosMat);
scene.add(atmosMesh);

// Water sphere
const waterMat = new THREE.MeshPhongMaterial({
    color:0x0c3a6e, transparent:true, opacity:0.55,
    shininess:120, specular:0x4488bb, depthWrite:false
});
export const waterMesh = new THREE.Mesh(new THREE.SphereGeometry(1.0,80,80), waterMat);
scene.add(waterMesh);

// Equirectangular map camera & controls
export const mapCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
mapCamera.position.set(0, 0, 5);
mapCamera.lookAt(0, 0, 0);

export function updateMapCameraFrustum() {
    const aspect = innerWidth / innerHeight;
    const mapAspect = 2;
    let halfW, halfH;
    if (aspect > mapAspect) {
        halfH = 1.15;
        halfW = halfH * aspect;
    } else {
        halfW = 2.3;
        halfH = halfW / aspect;
    }
    mapCamera.left = -halfW; mapCamera.right = halfW;
    mapCamera.top = halfH; mapCamera.bottom = -halfH;
    mapCamera.updateProjectionMatrix();
}
updateMapCameraFrustum();

export const mapCtrl = new OrbitControls(mapCamera, canvas);
mapCtrl.enableRotate = false;
mapCtrl.enablePan = false;
mapCtrl.enableDamping = true;
mapCtrl.dampingFactor = 0.09;
mapCtrl.panSpeed = 1.4;
mapCtrl.screenSpacePanning = true;
mapCtrl.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
mapCtrl.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN };
mapCtrl.minZoom = 0.5;
mapCtrl.maxZoom = 20;
mapCtrl.enableZoom = false; // custom handler below
mapCtrl.enabled = false;

// Smooth zoom for map view (orthographic)
let _mapZoomTarget = mapCamera.zoom;
const MAP_ZOOM_STEP   = 0.92;
const MAP_ZOOM_SMOOTH = 0.12;

export function getMapCameraZoom() {
    return _mapZoomTarget;
}

export function setMapCameraZoom(zoom, { immediate = false } = {}) {
    _mapZoomTarget = THREE.MathUtils.clamp(zoom, mapCtrl.minZoom, mapCtrl.maxZoom);
    if (immediate) {
        mapCamera.zoom = _mapZoomTarget;
        mapCamera.updateProjectionMatrix();
    }
    window.dispatchEvent(new CustomEvent('map-zoom-changed', { detail: { zoom: _mapZoomTarget } }));
}

canvas.addEventListener('wheel', (e) => {
    if (!mapCtrl.enabled) return;
    e.preventDefault();
    const dir = Math.sign(e.deltaY);
    setMapCameraZoom(_mapZoomTarget * (dir < 0 ? 1 / MAP_ZOOM_STEP : MAP_ZOOM_STEP));
}, { passive: false });

// Pinch-to-zoom for map (touch)
let _mapPinchDist = 0;
canvas.addEventListener('touchstart', (e) => {
    if (!mapCtrl.enabled || e.touches.length !== 2) { _mapPinchDist = 0; return; }
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    _mapPinchDist = Math.sqrt(dx * dx + dy * dy);
}, { passive: true });

canvas.addEventListener('touchmove', (e) => {
    if (!mapCtrl.enabled || e.touches.length !== 2 || _mapPinchDist === 0) return;
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const ratio = dist / _mapPinchDist;
    setMapCameraZoom(_mapZoomTarget * ratio);
    _mapPinchDist = dist;
}, { passive: true });

canvas.addEventListener('touchend', () => { _mapPinchDist = 0; }, { passive: true });

export function tickMapZoom() {
    const cur = mapCamera.zoom;
    const next = THREE.MathUtils.lerp(cur, _mapZoomTarget, MAP_ZOOM_SMOOTH);
    if (Math.abs(next - cur) < 0.0001) return;
    mapCamera.zoom = next;
    mapCamera.updateProjectionMatrix();
}

export function resetMapCameraView() {
    setMapCameraZoom(1, { immediate: true });
    mapCamera.position.set(0, 0, 5);
    mapCamera.lookAt(0, 0, 0);
    mapCtrl.target.set(0, 0, 0);
    updateMapCameraFrustum();
    mapCtrl.update();
}
