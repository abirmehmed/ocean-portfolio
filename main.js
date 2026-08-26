/**
 * Open Sea — a procedural WebGPU / Three.js TSL ocean scene.
 *
 * - Exactly five Gerstner waves displace a dense plane; swell normals are
 *   derived analytically from the closed-form partial derivatives of the
 *   Gerstner sum (no neighbour-sampling / finite-difference normals).
 * - Animated gradient-noise FBM adds fine capillary ripples as a normal
 *   perturbation layered on top of the analytic swell normal.
 * - One analytic sky() function is shared, with the same uniforms, by the
 *   sky dome mesh and the water's reflection / horizon-haze terms.
 * - TSL bloom + ACES tone mapping, damped OrbitControls with idle drift,
 *   live FPS, and a small set of runtime controls (sea state / time of day
 *   / drift) round out the scene.
 *
 * No textures, HDRIs, models or video are used — everything is procedural.
 */

import * as THREE from 'three/webgpu';
import {
  Fn, uniform, varying, vec2, vec3, float,
  positionLocal, positionWorld, cameraPosition, instanceIndex,
  normalize, dot, reflect, mix, clamp, smoothstep, pow, max as tmax,
  floor, fract, sin, cos, exp, length, atan, asin,
  pass
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// -----------------------------------------------------------------------
// DOM references
// -----------------------------------------------------------------------
const appEl = document.getElementById('app');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const errorOverlay = document.getElementById('error-overlay');
const errorTitle = document.getElementById('error-title');
const errorBody = document.getElementById('error-body');
const panel = document.getElementById('panel');
const togglePanelBtn = document.getElementById('settingsToggle');
const themeToggleBtn = document.getElementById('themeToggle');
const srLive = document.getElementById('sr-live');

const seaStateInput = document.getElementById('seaState');
const seaStateVal = document.getElementById('seaStateVal');
const timeOfDayInput = document.getElementById('timeOfDay');
const timeOfDayVal = document.getElementById('timeOfDayVal');
const driftInput = document.getElementById('drift');
const driftVal = document.getElementById('driftVal');
const rainInput = document.getElementById('rain');
const rainVal = document.getElementById('rainVal');
const soundToggleBtn = document.getElementById('soundToggle');
const fpsVal = document.getElementById('fpsVal');
const backendVal = document.getElementById('backendVal');

const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function showError(title, body) {
  loadingOverlay.classList.add('hidden');
  errorTitle.textContent = title;
  errorBody.textContent = body;
  errorOverlay.classList.add('visible');
  panel.classList.add('hidden');
  if (togglePanelBtn) togglePanelBtn.style.display = 'none';
  if (themeToggleBtn) themeToggleBtn.style.display = 'none';
}

function setLoadingText(msg) {
  if (loadingText) loadingText.textContent = msg;
}

// -----------------------------------------------------------------------
// Graceful WebGPU fallback: rather than blocking the whole page, an
// unsupported browser still gets the full portfolio (nav, all panels,
// carousel, contact form, case-study modals) — just without the live
// ocean render, which is swapped for a static gradient. Only the
// ocean-specific controls (Settings, day/night toggle) are hidden, since
// they'd have nothing to act on.
// -----------------------------------------------------------------------
function enterFallbackMode(reason) {
  console.warn(reason);
  document.body.classList.add('webgpu-unavailable');
  loadingOverlay.classList.add('hidden');
  setupPanelNav();
  setupCarousel();
  setupContactForm();
  setupCaseModal();
}

// =========================================================================
// Constants & tunables
// =========================================================================

const CLOCK_MAX_DELTA = 0.1;      // seconds, clamps huge deltas (tab resume, stalls)
const WATER_SIZE = 3000;          // plane extent (units)
const SKY_RADIUS = 4000;

// Five Gerstner waves: dominant swell -> fine wind chop. Fixed at build time
// (their count is exactly five, as required); sea state scales amplitude,
// steepness and, mildly, speed at runtime via shared uniforms.
const GERSTNER_WAVES = [
  { dir: [1.00, 0.22], wavelength: 78, amplitude: 0.85, steepness: 0.55, speedMul: 1.00 },
  { dir: [0.55, 0.95], wavelength: 39, amplitude: 0.46, steepness: 0.50, speedMul: 1.25 },
  { dir: [-0.85, 0.45], wavelength: 21, amplitude: 0.26, steepness: 0.45, speedMul: 1.55 },
  { dir: [0.30, -0.92], wavelength: 10, amplitude: 0.13, steepness: 0.40, speedMul: 2.05 },
  { dir: [-0.55, -0.40], wavelength: 4.6, amplitude: 0.055, steepness: 0.32, speedMul: 2.70 }
].map(w => {
  const len = Math.hypot(w.dir[0], w.dir[1]) || 1;
  return { ...w, dir: [w.dir[0] / len, w.dir[1] / len] };
});

const BASE_AMPLITUDE_SUM = GERSTNER_WAVES.reduce((s, w) => s + w.amplitude, 0);

// Device-adaptive mesh density: dense, but scaled down for weaker devices
// so the "dense plane" requirement doesn't tank frame rate everywhere.
function chooseSegmentCount() {
  const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  if (isCoarsePointer && (cores <= 4 || mem <= 4)) return 220;
  if (isCoarsePointer) return 280;
  if (cores <= 4) return 260;
  return 380;
}
const SEGMENTS = chooseSegmentCount();

// Device-adaptive rain instance count (same policy as SEGMENTS above).
function chooseRainCount() {
  const isCoarsePointer = window.matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency || 4;
  if (isCoarsePointer && cores <= 4) return 900;
  if (isCoarsePointer) return 1500;
  if (cores <= 4) return 2200;
  return 4000;
}
const RAIN_COUNT = chooseRainCount();
const RAIN_AREA = 150;   // footprint (world units) the rain field spans around the origin
const RAIN_HEIGHT = 42;  // vertical fall distance before a streak loops back to the top

// =========================================================================
// Shared TSL uniforms
// =========================================================================

const U = {
  time: uniform(0),                                   // seconds, manually accumulated (pausable)
  ampScale: uniform(0.55),                             // sea-state driven amplitude multiplier
  choppyScale: uniform(0.75),                          // sea-state driven steepness multiplier
  maxAmplitude: uniform(BASE_AMPLITUDE_SUM * 0.55),    // for height normalization
  windDir: uniform(new THREE.Vector2(GERSTNER_WAVES[0].dir[0], GERSTNER_WAVES[0].dir[1])),

  capFreq: uniform(0.55),
  capSpeed: uniform(0.35),
  capStrength: uniform(0.05),

  sunDirection: uniform(new THREE.Vector3(0.35, 0.55, 0.35).normalize()),
  sunColor: uniform(new THREE.Color(1.0, 0.92, 0.78)),

  deepColor: uniform(new THREE.Color(0.014, 0.055, 0.095)),
  shallowColor: uniform(new THREE.Color(0.03, 0.24, 0.28)),
  foamColor: uniform(new THREE.Color(0.92, 0.97, 1.0)),
  sssColor: uniform(new THREE.Color(0.35, 0.85, 0.65)),

  hazeDensity: uniform(0.0011),
  foamCoverage: uniform(0.28),
  foamCrestThreshold: uniform(0.55),
  glitterIntensity: uniform(1.0),
  shininess: uniform(1800.0),
  sssIntensity: uniform(0.9),

  cloudCoverage: uniform(0.42),
  cloudScale: uniform(0.9),
  cloudSpeed: uniform(0.015),

  rainIntensity: uniform(0.0),
  lightningFlash: uniform(0.0),

  exposureBoost: uniform(1.0)
};

// =========================================================================
// TSL helper functions
// =========================================================================

// Cheap 2D hash -> [0,1)
const hash2 = Fn(([p]) => {
  const h = dot(p, vec2(127.1, 311.7));
  return fract(sin(h).mul(43758.5453123));
});

// Smooth value noise in [0,1]
const valueNoise2D = Fn(([p]) => {
  const i = floor(p);
  const f = fract(p);
  const a = hash2(i);
  const b = hash2(i.add(vec2(1.0, 0.0)));
  const c = hash2(i.add(vec2(0.0, 1.0)));
  const d = hash2(i.add(vec2(1.0, 1.0)));
  const u = f.mul(f).mul(f.mul(-2.0).add(3.0)); // smoothstep-style interpolant
  const ab = mix(a, b, u.x);
  const cd = mix(c, d, u.x);
  return mix(ab, cd, u.y);
});

// Animated fractal Brownian motion built from the value noise above.
// `octaves` is a plain JS integer (compile-time unroll, not a GPU loop).
function fbm(pNode, octaves) {
  let amp = 0.5;
  let freq = 1.0;
  let sum = float(0.0);
  let norm = float(0.0);
  for (let i = 0; i < octaves; i++) {
    sum = sum.add(valueNoise2D(pNode.mul(freq)).mul(amp));
    norm = norm.add(amp);
    amp *= 0.5;
    freq *= 2.05; // slightly irrational lacunarity avoids obvious grid repeats
  }
  return sum.div(norm);
}

// Analytic Gerstner sum: returns { position, normal } for a point given in
// the plane's *undisplaced* local XZ domain. Five terms, unrolled in JS at
// graph-construction time (the count itself is fixed at exactly five).
function gerstnerSurface(domainXZ, t) {
  let dispX = float(0.0);
  let dispZ = float(0.0);
  let height = float(0.0);
  let nSumX = float(0.0);
  let nSumZ = float(0.0);
  let nSumY = float(0.0);

  for (const w of GERSTNER_WAVES) {
    const k = (2.0 * Math.PI) / w.wavelength;
    const dirX = w.dir[0];
    const dirZ = w.dir[1];
    const omega = Math.sqrt(9.81 * k) * w.speedMul;

    const kNode = float(k);
    const amp = U.ampScale.mul(w.amplitude);
    const steep = U.choppyScale.mul(w.steepness);

    const phase = domainXZ.x.mul(dirX * k)
      .add(domainXZ.y.mul(dirZ * k))
      .add(t.mul(omega));
    const s = sin(phase);
    const c = cos(phase);

    dispX = dispX.add(steep.mul(amp).mul(dirX).mul(c));
    dispZ = dispZ.add(steep.mul(amp).mul(dirZ).mul(c));
    height = height.add(amp.mul(s));

    nSumX = nSumX.add(kNode.mul(amp).mul(dirX).mul(c));
    nSumZ = nSumZ.add(kNode.mul(amp).mul(dirZ).mul(c));
    nSumY = nSumY.add(steep.mul(kNode).mul(amp).mul(s));
  }

  const position = vec3(domainXZ.x.add(dispX), height, domainXZ.y.add(dispZ));
  const normal = normalize(vec3(nSumX.negate(), float(1.0).sub(nSumY), nSumZ.negate()));
  return { position, normal };
}

// Soft, anti-aliased starfield: each grid cell may contain a small round
// star with a randomized position/size/brightness. Using a smooth radial
// falloff (instead of a hard single-texel threshold) avoids feeding bloom
// single-pixel HDR spikes, which is what caused the vertical streaking.
const starField = Fn(([rdIn]) => {
  // Raw direction x/z components barely change with pitch near the horizon
  // (their derivative collapses there), so a grid built from rd.xz directly
  // makes a star's cell stay constant across many screen rows near the
  // horizon -> it redraws itself into a vertical streak. A true spherical
  // (azimuth, elevation) parametrization doesn't degenerate that way.
  const azimuth = atan(rdIn.z, rdIn.x);           // -PI..PI, smooth at all elevations
  const elevation = asin(clamp(rdIn.y, -1.0, 1.0)); // -PI/2..PI/2, smooth everywhere

  const scale = float(140.0);
  const p = vec2(azimuth, elevation).mul(scale);
  const cell = floor(p);
  const f = fract(p);

  const rnd = hash2(cell);
  const rnd2 = hash2(cell.add(vec2(17.13, 91.71)));
  const jitter = vec2(rnd, rnd2).mul(0.7).add(0.15); // keep stars off cell edges

  const d = length(f.sub(jitter));
  const radius = mix(0.05, 0.11, rnd2);
  const disc = smoothstep(radius, radius.mul(0.35), d);

  const present = smoothstep(0.975, 0.985, rnd2); // sparse: only ~1-2% of cells host a star
  const brightness = mix(0.12, 0.38, rnd); // capped well under the bloom threshold

  return disc.mul(present).mul(brightness);
});

// ---- Shared analytic sky, used by both the sky dome and water reflections ----
// rd: normalized ray/view direction (world space).
const skyColor = Fn(([rdIn]) => {
  // Keep the ray from diving under the horizon so reflections never sample
  // a "black hole" underside of the analytic sky.
  const rd = normalize(vec3(rdIn.x, tmax(rdIn.y, 0.015), rdIn.z));

  const sunDir = U.sunDirection;
  const elevation = sunDir.y; // -1..1

  const nightT = smoothstep(0.05, -0.2, elevation);
  const dawnT = smoothstep(-0.15, 0.1, elevation).mul(smoothstep(0.5, 0.1, elevation));
  const dayT = smoothstep(0.0, 0.35, elevation);

  const nightZenith = vec3(0.008, 0.013, 0.03);
  const nightHorizon = vec3(0.02, 0.03, 0.052);
  const dawnZenith = vec3(0.16, 0.24, 0.46);
  const dawnHorizon = vec3(0.95, 0.55, 0.35);
  const dayZenith = vec3(0.14, 0.38, 0.72);
  const dayHorizon = vec3(0.62, 0.78, 0.86);

  let zenith = mix(nightZenith, dayZenith, dayT);
  zenith = mix(zenith, dawnZenith, dawnT.mul(float(1.0).sub(dayT)));
  let horizon = mix(nightHorizon, dayHorizon, dayT);
  horizon = mix(horizon, dawnHorizon, dawnT);

  const upT = pow(clamp(rd.y, 0.0, 1.0), 0.45);
  let col = mix(horizon, zenith, upT);

  // Sun disc + halo, using the same sun direction the water reflects.
  const sunAmount = clamp(dot(rd, sunDir), 0.0, 1.0);
  const visible = smoothstep(-0.06, 0.03, elevation);
  const disc = smoothstep(0.9992, 0.9998, sunAmount);
  const halo = pow(sunAmount, 24.0).mul(0.5).add(pow(sunAmount, 4.0).mul(0.18));
  col = col.add(U.sunColor.mul(disc.mul(3.2).add(halo)).mul(visible));

  // Clouds: fbm projected onto the sky dome, scrolling with wind.
  const cloudUV = rd.xz.div(rd.y.add(0.12)).mul(U.cloudScale)
    .add(U.windDir.mul(U.time).mul(U.cloudSpeed));
  const cloudN = fbm(cloudUV, 4);
  const coverageEdge = float(1.0).sub(U.cloudCoverage);
  const cloudMask = smoothstep(coverageEdge, coverageEdge.add(0.35), cloudN)
    .mul(smoothstep(0.0, 0.22, rd.y));
  const sunGlow = pow(sunAmount, 3.0);
  const cloudLit = mix(vec3(0.62, 0.66, 0.74), vec3(1.0, 0.86, 0.72), sunGlow.mul(visible));
  const cloudShadow = cloudLit.mul(mix(vec3(0.45, 0.46, 0.55), vec3(1.0), dayT));
  const nightCloud = vec3(0.045, 0.06, 0.095);
  const skyLitAmount = clamp(dayT.add(dawnT).mul(1.4), 0.0, 1.0);
  const stormDarken = float(1.0).sub(U.rainIntensity.mul(0.45));
  const cloudFinal = mix(nightCloud, cloudShadow, skyLitAmount).mul(stormDarken);
  col = mix(col, cloudFinal, cloudMask.mul(0.85));

  // A very light starfield, fading in only once the sun is well below the horizon.
  const stars = starField(normalize(rdIn)).mul(nightT);
  col = col.add(vec3(stars));

  // Lightning: a soft overall brightening, shared by the dome and the
  // water's reflection since both call this same function.
  col = col.add(vec3(1.0, 0.98, 0.96).mul(U.lightningFlash).mul(0.85));

  return col;
});

// =========================================================================
// Renderer / scene bootstrap
// =========================================================================

let renderer, scene, camera, controls, postProcessing;
let waterMesh, skyMesh, rainMesh;
let running = false;
let disposed = false;

async function init() {
  if (!('gpu' in navigator)) {
    enterFallbackMode('WebGPU not supported: navigator.gpu is missing.');
    return;
  }

  try {
    renderer = new THREE.WebGPURenderer({ antialias: true, powerPreference: 'high-performance' });
    await renderer.init();

    // Defensive check: don't silently accept a non-WebGPU backend.
    if (renderer.backend && renderer.backend.isWebGPUBackend === false) {
      throw new Error('Renderer initialized on a non-WebGPU backend.');
    }
  } catch (err) {
    enterFallbackMode(`WebGPU failed to initialize: ${err && err.message ? err.message : err}`);
    return;
  }

  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.domElement.setAttribute('aria-hidden', 'true');
  renderer.domElement.tabIndex = -1;
  appEl.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 6200);
  camera.position.set(0, 9, 34);

  buildSky();
  buildWater();
  buildRain();
  buildControls();
  buildPostProcessing();

  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibilityChange);
  wireUI();
  setupPanelNav();
  setupCarousel();
  setupContactForm();
  setupCaseModal();

  backendVal.textContent = 'WebGPU';
  loadingOverlay.classList.add('hidden');
  updateRunState();
}

// -------------------------------------------------------------------------
// Sky dome
// -------------------------------------------------------------------------
function buildSky() {
  const geo = new THREE.SphereGeometry(SKY_RADIUS, 40, 24);
  const mat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false, depthWrite: false });

  mat.colorNode = Fn(() => {
    const rd = normalize(positionWorld.sub(cameraPosition));
    return skyColor(rd);
  })();

  skyMesh = new THREE.Mesh(geo, mat);
  skyMesh.renderOrder = -10;
  skyMesh.matrixAutoUpdate = false;
  skyMesh.updateMatrix();
  scene.add(skyMesh);
}

// -------------------------------------------------------------------------
// Water
// -------------------------------------------------------------------------
function buildWater() {
  const geo = new THREE.PlaneGeometry(WATER_SIZE, WATER_SIZE, SEGMENTS, SEGMENTS);
  geo.rotateX(-Math.PI / 2);

  const mat = new THREE.MeshBasicNodeMaterial({ fog: false });

  // Build the analytic Gerstner surface once. The water mesh has an
  // identity world transform, so the local-space swell normal below is
  // already a world-space normal (no normal-matrix step needed).
  const domain = vec2(positionLocal.x, positionLocal.z);
  const swell = gerstnerSurface(domain, U.time);

  // Vertex stage: analytic Gerstner displacement.
  mat.positionNode = swell.position;

  // MeshBasicNodeMaterial deliberately ignores material.normalNode (it
  // always shades with the raw geometry normal instead), so the analytic
  // swell normal is carried from the vertex stage to the fragment stage
  // explicitly via a varying rather than through normalNode/normalWorld.
  const vSwellNormal = varying(swell.normal, 'vSwellNormal');

  // Fragment stage: capillary FBM bump + full shading.
  mat.colorNode = Fn(() => {
    const p = positionWorld.xz;

    // --- capillary normal perturbation (animated gradient-noise FBM) ---
    const eps = float(0.12);
    const capUV = p.mul(U.capFreq).add(U.windDir.mul(U.time).mul(U.capSpeed));
    const hC = fbm(capUV, 3);
    const hX = fbm(capUV.add(vec2(eps, 0.0)), 3);
    const hZ = fbm(capUV.add(vec2(0.0, eps)), 3);
    const gx = hX.sub(hC).div(eps);
    const gz = hZ.sub(hC).div(eps);
    const capBump = vec3(gx.negate(), 0.0, gz.negate()).mul(U.capStrength);

    // Rain dappling: a finer, faster-scrolling ripple layer that only
    // contributes once rainIntensity rises above zero.
    const rainUV = p.mul(1.8).add(U.windDir.mul(U.time).mul(1.1));
    const rC = fbm(rainUV, 2);
    const rX = fbm(rainUV.add(vec2(eps, 0.0)), 2);
    const rZ = fbm(rainUV.add(vec2(0.0, eps)), 2);
    const rainBump = vec3(rX.sub(rC).negate(), 0.0, rZ.sub(rC).negate())
      .div(eps).mul(0.025).mul(U.rainIntensity);

    const N = normalize(vSwellNormal.add(capBump).add(rainBump));
    const V = normalize(cameraPosition.sub(positionWorld));
    const NdotV = tmax(dot(N, V), 0.0001);
    const ambient = smoothstep(-0.2, 0.15, U.sunDirection.y).mul(0.85).add(0.15);

    // --- Fresnel (Schlick) ---
    const F0 = float(0.02);
    const fresnel = F0.add(float(1.0).sub(F0).mul(pow(float(1.0).sub(NdotV), 5.0)));

    // --- sky reflection, using the SAME analytic sky() as the dome ---
    const reflectDir = normalize(reflect(V.negate(), N));
    const skyRefl = skyColor(reflectDir);

    // --- deep water base colour, lifted toward shallow tint on crests ---
    const heightNorm = clamp(positionWorld.y.div(U.maxAmplitude), -1.0, 1.0);
    const base = mix(U.deepColor, U.shallowColor, smoothstep(-0.15, 0.65, heightNorm)).mul(ambient);

    let color = mix(base, skyRefl, fresnel);

    // --- backlit crests (thin-shell transmission toward the sun) ---
    const towardSun = clamp(dot(V.negate(), U.sunDirection), 0.0, 1.0);
    const crestFactor = clamp(heightNorm, 0.0, 1.0);
    const tilt = clamp(dot(N, U.sunDirection), 0.0, 1.0);
    const sss = pow(towardSun, 6.0).mul(crestFactor).mul(tilt).mul(U.sssIntensity);
    color = color.add(U.sssColor.mul(sss));

    // --- sun glitter ---
    const H = normalize(V.add(U.sunDirection));
    const NdotH = clamp(dot(N, H), 0.0, 1.0);
    const dayVisible = smoothstep(-0.05, 0.05, U.sunDirection.y);
    const spec = pow(NdotH, U.shininess).mul(U.glitterIntensity).mul(dayVisible);
    color = color.add(U.sunColor.mul(spec));

    // --- foam: crest height + steepness, patterned by a second FBM field ---
    const steep = clamp(float(1.0).sub(N.y), 0.0, 1.0);
    const crestMask = smoothstep(
      U.foamCrestThreshold.sub(0.18),
      U.foamCrestThreshold.add(0.08),
      heightNorm
    );
    const foamN = fbm(p.mul(0.12).add(U.windDir.mul(U.time).mul(0.045)), 3);
    const foamPattern = smoothstep(0.32, 0.72, foamN);
    const foamMask = clamp(crestMask.mul(0.75).add(steep.mul(0.6)), 0.0, 1.0)
      .mul(foamPattern).mul(U.foamCoverage);
    color = mix(color, U.foamColor.mul(ambient), clamp(foamMask, 0.0, 1.0));

    // --- horizon haze, mixed toward the sky colour along the view ray ---
    const dist = length(cameraPosition.sub(positionWorld));
    const haze = float(1.0).sub(exp(dist.mul(U.hazeDensity).negate()));
    const rayColor = skyColor(V.negate());
    color = mix(color, rayColor, clamp(haze, 0.0, 1.0));

    return color;
  })();

  waterMesh = new THREE.Mesh(geo, mat);
  waterMesh.frustumCulled = false;
  scene.add(waterMesh);
}

// -------------------------------------------------------------------------
// Rain — GPU-driven instanced streaks, fully animated via instanceIndex.
// -------------------------------------------------------------------------
function buildRain() {
  const geo = new THREE.BoxGeometry(1, 1, 1); // unit box; sized per-instance in the shader

  const mat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    fog: false
  });

  rainMesh = new THREE.InstancedMesh(geo, mat, RAIN_COUNT);
  rainMesh.frustumCulled = false; // shader-displaced instances have no valid built-in bounds

  // Insurance: InstancedMesh leaves instanceMatrix as all-zero until you set it,
  // which would zero out every instance if the node pipeline ever consults it.
  // positionNode below fully replaces the per-instance transform, but setting
  // identity matrices costs nothing and removes that failure mode entirely.
  const identity = new THREE.Matrix4();
  for (let i = 0; i < RAIN_COUNT; i++) rainMesh.setMatrixAt(i, identity);
  rainMesh.instanceMatrix.needsUpdate = true;

  const idx = float(instanceIndex);
  const seed = vec2(idx, idx.mul(1.61803398875));
  const rx = hash2(seed);
  const rz = hash2(seed.add(vec2(13.73, 47.31)));
  const phaseY = hash2(seed.add(vec2(91.17, 5.34)));
  const speedVar = hash2(seed.add(vec2(3.31, 71.13)));
  const sizeVar = hash2(seed.add(vec2(29.7, 61.9)));

  const worldX = rx.sub(0.5).mul(RAIN_AREA);
  const worldZ = rz.sub(0.5).mul(RAIN_AREA);

  const fallSpeed = mix(9.0, 14.0, speedVar);
  const heightFrac = fract(phaseY.sub(U.time.mul(fallSpeed).div(RAIN_HEIGHT)));
  const worldY = heightFrac.mul(RAIN_HEIGHT);

  const streakWidth = mix(0.012, 0.022, sizeVar);
  const streakHeight = mix(1.4, 2.4, sizeVar);

  // Gentle wind-driven tilt along the streak's own local height.
  const tiltAmount = 0.4;
  const localUp = positionLocal.y.add(0.5); // 0 at the base, 1 at the tip
  const tilt = U.windDir.mul(localUp).mul(tiltAmount);

  mat.positionNode = Fn(() => {
    const local = vec3(
      positionLocal.x.mul(streakWidth).add(tilt.x),
      positionLocal.y.mul(streakHeight),
      positionLocal.z.mul(streakWidth).add(tilt.y)
    );
    return local.add(vec3(worldX, worldY, worldZ));
  })();

  mat.colorNode = vec3(0.72, 0.78, 0.85);

  mat.opacityNode = Fn(() => {
    const dist = length(cameraPosition.sub(positionWorld));
    const nearFade = smoothstep(1.5, 9.0, dist);
    const farFade = smoothstep(RAIN_AREA * 0.62, RAIN_AREA * 0.18, dist);
    const waterFade = smoothstep(0.0, 3.5, worldY);
    const ambient = smoothstep(-0.2, 0.15, U.sunDirection.y).mul(0.8).add(0.2);
    return float(0.3).mul(nearFade).mul(farFade).mul(waterFade).mul(ambient).mul(U.rainIntensity);
  })();

  rainMesh.visible = false;
  scene.add(rainMesh);
}

// -------------------------------------------------------------------------
// Post-processing: TSL bloom + ACES (tone mapping applied by renderer.toneMapping)
// -------------------------------------------------------------------------
function buildPostProcessing() {
  postProcessing = new THREE.PostProcessing(renderer);
  const scenePass = pass(scene, camera);
  const scenePassColor = scenePass.getTextureNode();
  const bloomPass = bloom(scenePassColor, 0.4, 0.35, 1.05);
  postProcessing.outputNode = scenePassColor.add(bloomPass);
}

// -------------------------------------------------------------------------
// Controls (OrbitControls + gentle idle drift)
// -------------------------------------------------------------------------
let driftAmount = prefersReducedMotion ? 0 : 0.2;
let lastInteraction = 0;
const IDLE_BEFORE_DRIFT = 1.6; // seconds of inactivity before drift resumes

// -------------------------------------------------------------------------
// Quick day/night toggle — animates the same timeOfDay control smoothly
// rather than snapping, and stays in sync with the Settings panel slider
// in both directions (applyTimeOfDay updates this toggle's own state too).
// -------------------------------------------------------------------------
let nightMode = false;
let timeTweenActive = false;
let timeTweenFrom = 12;
let timeTweenTo = 0;
let timeTweenElapsed = 0;
const TIME_TWEEN_DURATION = prefersReducedMotion ? 0.01 : 2.4; // seconds

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function setNightMode(on) {
  nightMode = on;
  timeTweenFrom = parseFloat(timeOfDayInput.value);
  timeTweenTo = on ? 0 : 12;
  timeTweenElapsed = 0;
  timeTweenActive = true;
}

// -------------------------------------------------------------------------
// Audio: procedural rain hiss + thunder (no audio files — same "no external
// assets" rule as the visuals). Created lazily on the Sound toggle so it
// only ever starts inside a real user gesture (autoplay policy).
// -------------------------------------------------------------------------
let audioCtx = null;
let masterGain = null;
let rainNoiseGain = null;
let soundEnabled = false;
let thunderTimer = null;
let lightningEnvelope = 0;

function makeNoiseBuffer(seconds) {
  const buf = audioCtx.createBuffer(1, Math.max(1, Math.floor(audioCtx.sampleRate * seconds)), audioCtx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function ensureAudio() {
  if (audioCtx) return true;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return false;
    audioCtx = new Ctx();

    masterGain = audioCtx.createGain();
    masterGain.gain.value = 0;
    masterGain.connect(audioCtx.destination);

    // Looping filtered noise -> rain hiss.
    const rainSource = audioCtx.createBufferSource();
    rainSource.buffer = makeNoiseBuffer(2.0);
    rainSource.loop = true;

    const rainHighpass = audioCtx.createBiquadFilter();
    rainHighpass.type = 'highpass';
    rainHighpass.frequency.value = 500;

    const rainLowpass = audioCtx.createBiquadFilter();
    rainLowpass.type = 'lowpass';
    rainLowpass.frequency.value = 5200;

    rainNoiseGain = audioCtx.createGain();
    rainNoiseGain.gain.value = U.rainIntensity.value * 0.5;

    rainSource.connect(rainHighpass);
    rainHighpass.connect(rainLowpass);
    rainLowpass.connect(rainNoiseGain);
    rainNoiseGain.connect(masterGain);
    rainSource.start();

    return true;
  } catch (err) {
    console.error(err);
    audioCtx = null;
    return false;
  }
}

function playThunderSound() {
  if (!audioCtx || !soundEnabled) return;
  const now = audioCtx.currentTime;

  // Crack: short, bright noise burst with a fast downward filter sweep.
  const crackSource = audioCtx.createBufferSource();
  crackSource.buffer = makeNoiseBuffer(0.4);
  const crackFilter = audioCtx.createBiquadFilter();
  crackFilter.type = 'lowpass';
  crackFilter.frequency.setValueAtTime(3200, now);
  crackFilter.frequency.exponentialRampToValueAtTime(200, now + 0.5);
  const crackGain = audioCtx.createGain();
  crackGain.gain.setValueAtTime(0.85, now);
  crackGain.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
  crackSource.connect(crackFilter);
  crackFilter.connect(crackGain);
  crackGain.connect(masterGain);
  crackSource.start(now);
  crackSource.stop(now + 0.5);

  // Rumble: long, low-passed noise tail.
  const rumbleSource = audioCtx.createBufferSource();
  rumbleSource.buffer = makeNoiseBuffer(3.0);
  const rumbleFilter = audioCtx.createBiquadFilter();
  rumbleFilter.type = 'lowpass';
  rumbleFilter.frequency.value = 120;
  const rumbleGain = audioCtx.createGain();
  rumbleGain.gain.setValueAtTime(0.0001, now);
  rumbleGain.gain.exponentialRampToValueAtTime(0.5, now + 0.4);
  rumbleGain.gain.exponentialRampToValueAtTime(0.001, now + 3.0);
  rumbleSource.connect(rumbleFilter);
  rumbleFilter.connect(rumbleGain);
  rumbleGain.connect(masterGain);
  rumbleSource.start(now);
  rumbleSource.stop(now + 3.0);
}

function triggerLightning() {
  lightningEnvelope = 1.0;
  setTimeout(() => { lightningEnvelope = Math.max(lightningEnvelope, 0.5); }, 130);

  if (soundEnabled) {
    const delay = 300 + Math.random() * 1700; // light arrives before sound
    setTimeout(playThunderSound, delay);
  }
}

function scheduleThunder(intensity) {
  if (thunderTimer) {
    clearTimeout(thunderTimer);
    thunderTimer = null;
  }
  if (intensity < 0.15 || document.hidden) return;
  const minDelay = THREE.MathUtils.lerp(15000, 4500, intensity);
  const maxDelay = THREE.MathUtils.lerp(27000, 10000, intensity);
  const delay = minDelay + Math.random() * (maxDelay - minDelay);
  thunderTimer = setTimeout(() => {
    triggerLightning();
    scheduleThunder(U.rainIntensity.value);
  }, delay);
}

function buildControls() {
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.minDistance = 6;
  controls.maxDistance = 220;
  controls.maxPolarAngle = Math.PI * 0.497;
  controls.minPolarAngle = 0.05;
  controls.target.set(0, 1, 0);
  controls.enablePan = false;
  controls.rotateSpeed = 0.55;
  controls.zoomSpeed = 0.7;
  controls.update();

  const markInteraction = () => { lastInteraction = clock.elapsedTime; };
  controls.addEventListener('start', markInteraction);
  renderer.domElement.addEventListener('pointerdown', markInteraction, { passive: true });
  renderer.domElement.addEventListener('wheel', markInteraction, { passive: true });
}

// =========================================================================
// Sea state / time-of-day derived uniform updates
// =========================================================================

function applySeaState(t01) {
  const s = THREE.MathUtils.clamp(t01, 0, 1);
  U.ampScale.value = THREE.MathUtils.lerp(0.12, 1.65, s);
  U.choppyScale.value = THREE.MathUtils.lerp(0.35, 1.15, s);
  U.maxAmplitude.value = BASE_AMPLITUDE_SUM * U.ampScale.value * 0.62 + 0.05;
  U.capStrength.value = THREE.MathUtils.lerp(0.018, 0.11, s);
  U.capSpeed.value = THREE.MathUtils.lerp(0.22, 0.6, s);
  U.foamCoverage.value = THREE.MathUtils.lerp(0.02, 0.85, s);
  U.foamCrestThreshold.value = THREE.MathUtils.lerp(0.82, 0.32, s);
  U.shininess.value = THREE.MathUtils.lerp(6000.0, 220.0, s);
  U.glitterIntensity.value = THREE.MathUtils.lerp(1.4, 0.45, s);

  seaStateVal.textContent = `${Math.round(s * 100)}%`;
  const label = s < 0.18 ? 'calm sea' : s < 0.45 ? 'moderate sea' : s < 0.75 ? 'rough sea' : 'stormy sea';
  seaStateInput.setAttribute('aria-valuetext', `${Math.round(s * 100)} percent, ${label}`);
}

function applyTimeOfDay(hours) {
  const h = THREE.MathUtils.euclideanModulo(hours, 24);
  const angle = ((h - 6) / 24) * Math.PI * 2;
  const elevation = Math.sin(angle) * 1.3; // radians, allows deep-night range
  const azimuth = 2.15;

  const dir = new THREE.Vector3(
    Math.cos(elevation) * Math.cos(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.sin(azimuth)
  ).normalize();
  U.sunDirection.value.copy(dir);

  const t = THREE.MathUtils.clamp((dir.y + 0.15) / 0.5, 0, 1);
  const warm = new THREE.Color(1.0, 0.55, 0.28);
  const white = new THREE.Color(1.0, 0.95, 0.86);
  const c = warm.clone().lerp(white, t);
  const nightT = THREE.MathUtils.clamp(-dir.y / 0.35, 0, 1);
  c.lerp(new THREE.Color(0.06, 0.08, 0.14), nightT * 0.92);
  U.sunColor.value.copy(c);

  if (themeToggleBtn) {
    const isNight = dir.y < 0.02;
    nightMode = isNight;
    themeToggleBtn.setAttribute('aria-pressed', String(isNight));
    themeToggleBtn.setAttribute('aria-label', isNight ? 'Switch to day' : 'Switch to night');
  }

  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60).toString().padStart(2, '0');
  timeOfDayVal.textContent = `${hh.toString().padStart(2, '0')}:${mm}`;
  timeOfDayInput.setAttribute('aria-valuetext', `${hh}:${mm}`);
}

function applyDrift(t01) {
  driftAmount = prefersReducedMotion ? 0 : THREE.MathUtils.clamp(t01, 0, 1);
  driftVal.textContent = `${Math.round(driftAmount * 100)}%`;
  driftInput.setAttribute('aria-valuetext', `${Math.round(driftAmount * 100)} percent`);
}

function applyRain(t01) {
  const r = THREE.MathUtils.clamp(t01, 0, 1);
  U.rainIntensity.value = r;
  U.cloudCoverage.value = THREE.MathUtils.lerp(0.42, 0.92, r);
  if (rainMesh) rainMesh.visible = r > 0.001;
  if (rainNoiseGain && audioCtx) {
    rainNoiseGain.gain.setTargetAtTime(r * 0.5, audioCtx.currentTime, 0.2);
  }
  rainVal.textContent = `${Math.round(r * 100)}%`;
  rainInput.setAttribute('aria-valuetext', `${Math.round(r * 100)} percent`);
  scheduleThunder(r);
}

// =========================================================================
// UI wiring
// =========================================================================

function wireUI() {
  applySeaState(parseFloat(seaStateInput.value) / 100);
  applyTimeOfDay(parseFloat(timeOfDayInput.value));
  applyDrift(parseFloat(driftInput.value) / 100);
  applyRain(parseFloat(rainInput.value) / 100);

  seaStateInput.addEventListener('input', () => applySeaState(parseFloat(seaStateInput.value) / 100));
  timeOfDayInput.addEventListener('input', () => applyTimeOfDay(parseFloat(timeOfDayInput.value)));
  driftInput.addEventListener('input', () => applyDrift(parseFloat(driftInput.value) / 100));
  rainInput.addEventListener('input', () => applyRain(parseFloat(rainInput.value) / 100));

  soundToggleBtn.addEventListener('click', () => {
    if (!ensureAudio()) {
      soundToggleBtn.textContent = 'Unavailable';
      soundToggleBtn.disabled = true;
      soundToggleBtn.setAttribute('aria-pressed', 'false');
      return;
    }
    soundEnabled = !soundEnabled;
    audioCtx.resume();
    masterGain.gain.setTargetAtTime(soundEnabled ? 0.7 : 0.0, audioCtx.currentTime, 0.06);
    soundToggleBtn.textContent = soundEnabled ? 'Sound: On' : 'Sound: Off';
    soundToggleBtn.setAttribute('aria-pressed', String(soundEnabled));
    if (soundEnabled) scheduleThunder(U.rainIntensity.value);
    else if (thunderTimer) { clearTimeout(thunderTimer); thunderTimer = null; }
  });

  if (prefersReducedMotion) {
    driftInput.value = '0';
    driftInput.disabled = true;
    applyDrift(0);
  }

  togglePanelBtn.addEventListener('click', () => {
    const hidden = panel.classList.toggle('hidden');
    togglePanelBtn.setAttribute('aria-expanded', String(!hidden));
    togglePanelBtn.setAttribute('aria-label', hidden ? 'Open settings' : 'Close settings');
    const backdrop = document.getElementById('panelBackdrop');
    if (backdrop) backdrop.classList.toggle('visible', !hidden);
  });

  const panelBackdrop = document.getElementById('panelBackdrop');
  if (panelBackdrop) {
    panelBackdrop.addEventListener('click', () => {
      panel.classList.add('hidden');
      panelBackdrop.classList.remove('visible');
      togglePanelBtn.setAttribute('aria-expanded', 'false');
      togglePanelBtn.setAttribute('aria-label', 'Open settings');
    });
  }

  themeToggleBtn.addEventListener('click', () => setNightMode(!nightMode));
}

// =========================================================================
// Resize / visibility / performance safeguards
// =========================================================================

function onResize() {
  if (!renderer || !camera) return;
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
  renderer.setSize(w, h);
}

let tabVisible = !document.hidden;

function updateRunState() {
  const shouldRun = tabVisible && !disposed;
  if (shouldRun && !running) {
    running = true;
    clock.getDelta(); // drop whatever gap accumulated while paused
    requestAnimationFrame(loop);
    if (audioCtx && soundEnabled) audioCtx.resume();
    scheduleThunder(U.rainIntensity.value);
  } else if (!shouldRun && running) {
    running = false;
    if (audioCtx) audioCtx.suspend();
    if (thunderTimer) { clearTimeout(thunderTimer); thunderTimer = null; }
  }
}

function onVisibilityChange() {
  tabVisible = !document.hidden;
  updateRunState();
  if (carouselApi) {
    if (tabVisible) carouselApi.restart();
    else carouselApi.stop();
  }
}

// -------------------------------------------------------------------------
// Panel switching: exactly one of home/about/work/contact is .active at a
// time. Triggered by nav clicks AND by scroll-wheel (deliberately takes
// over the wheel entirely — see the capture-phase listener below — since
// OrbitControls also listens for wheel to zoom the ocean, and the two
// can't both own it without fighting each other).
// -------------------------------------------------------------------------
const PANEL_ORDER = ['home', 'about', 'skills', 'work', 'contact'];
let currentPanelIndex = 0;
const panelsMap = {};
let panelNavButtons = [];

function goToPanelIndex(index) {
  const clamped = Math.max(0, Math.min(PANEL_ORDER.length - 1, index));
  const name = PANEL_ORDER[clamped];
  const target = panelsMap[name];
  if (!target) return;

  currentPanelIndex = clamped;
  if (!target.classList.contains('active')) {
    Object.values(panelsMap).forEach((el) => el.classList.remove('active'));
    target.classList.add('active');
  }
  panelNavButtons.forEach((btn) => btn.setAttribute('aria-pressed', String(btn.dataset.panel === name)));

  if (carouselApi) {
    if (name === 'work') carouselApi.start(); else carouselApi.stop();
  }
}

function setupPanelNav() {
  panelNavButtons = Array.from(document.querySelectorAll('[data-panel]'));
  document.querySelectorAll('.content-panel').forEach((el) => {
    panelsMap[el.dataset.panelContent] = el;
  });

  panelNavButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = PANEL_ORDER.indexOf(btn.dataset.panel);
      if (idx !== -1) goToPanelIndex(idx);
    });
  });

  let wheelCooldown = false;
  window.addEventListener('wheel', (e) => {
    const modal = document.getElementById('caseModal');
    if (modal && modal.classList.contains('open')) return; // let the modal scroll normally

    const hoveredPanel = e.target.closest && (e.target.closest('.content-panel') || e.target.closest('#panel'));
    if (hoveredPanel && hoveredPanel.scrollHeight > hoveredPanel.clientHeight + 1) return; // let it scroll internally

    e.preventDefault();
    e.stopPropagation();
    if (wheelCooldown || Math.abs(e.deltaY) < 12) return;
    wheelCooldown = true;
    setTimeout(() => { wheelCooldown = false; }, 750);
    goToPanelIndex(currentPanelIndex + (e.deltaY > 0 ? 1 : -1));
  }, { passive: false, capture: true });

  goToPanelIndex(0); // sync aria-pressed for the default (Home) tab
}

// -------------------------------------------------------------------------
// Work: a data-driven set of project cards. Add more projects here later —
// the rotator below adapts automatically, no HTML editing required.
// -------------------------------------------------------------------------
const PROJECTS = [
  {
    tag: 'WebGPU',
    title: 'Open Sea',
    description: "A real-time procedural ocean — Gerstner waves, analytic normals, TSL bloom, and a shared analytic sky. The page you're on right now.",
    linkText: 'This page →',
    href: null,
    image: null,
    features: [
      'Five Gerstner waves with analytic (not neighbor-sampled) normals',
      'Procedural sky, sun, clouds, and rain/thunder — no textures or video',
      'TSL bloom, ACES tone mapping, day/night and sea-state controls'
    ]
  },
  {
    tag: 'Laravel · Livewire · PHP',
    title: 'UniMart',
    description: 'A full-stack POS (point of sale) application built with Laravel and Livewire.',
    linkText: 'View demo →',
    href: 'https://uni-mart.onrender.com/',
    image: 'thumb-unimart.jpg',
    features: [
      'Live inventory sync across the product catalog',
      'Shopping cart with add-to-cart flow',
      'Staff login for point-of-sale access'
    ]
  },
  {
    tag: 'React · Express',
    title: 'Sonix Store',
    description: 'A full-stack e-commerce store built with React.js on the frontend and Express on the backend.',
    linkText: 'View demo →',
    href: 'https://sonix-store.vercel.app/',
    image: 'thumb-sonix.jpg',
    features: [
      'Product detail page with pricing and discounts',
      'Customer ratings and review counts',
      'Cart and checkout flow'
    ]
  },
  {
    tag: 'Coming Soon',
    title: 'Next Project',
    description: 'Something new is in the works — check back soon, or ask me about it directly.',
    linkText: null,
    href: null,
    image: null,
    features: []
  }
];

// A real sliding carousel — up to 3 cards physically move, with clones
// padding both ends of the track so it loops seamlessly forward AND
// backward (the standard infinite-carousel technique: slide past the
// clones, then snap invisibly back into the real range with the
// transition switched off for that one frame). Auto-advances every 3s
// while the Work panel is active (paused on hover/manual interaction/
// hidden tab, skipped under reduced motion). Shows 1 card at a time on
// narrow screens, 3 on wider ones.
const CAROUSEL_GAP = 14;
let carouselApi = null;

function setupCarousel() {
  const rotator = document.getElementById('workRotator');
  const dotsWrap = document.getElementById('carouselDots');
  const prevBtn = document.getElementById('carouselPrev');
  const nextBtn = document.getElementById('carouselNext');
  const N = PROJECTS.length;
  if (!rotator || !dotsWrap || !prevBtn || !nextBtn || N === 0) return;

  const w = Math.min(window.innerWidth < 700 ? 1 : 3, N);

  const track = document.createElement('div');
  track.className = 'work-track';
  rotator.appendChild(track);

  function buildSlide() {
    const slide = document.createElement('div');
    slide.className = 'carousel-slide';
    slide.style.flex = `0 0 calc((100% - ${(w - 1) * CAROUSEL_GAP}px) / ${w})`;
    slide.innerHTML =
      '<div class="card-thumb"><img alt="" /></div>' +
      '<div class="card-body">' +
      '<div class="card-head"><span class="tag"></span><span class="live-badge"><span class="status-dot" aria-hidden="true"></span>Live</span></div>' +
      '<h3></h3><p></p>' +
      '<div class="card-links"><a class="demo-link" target="_blank" rel="noopener noreferrer"></a><button type="button" class="case-link">Details →</button></div>' +
      '</div>';
    return slide;
  }

  function fillSlide(slide, project) {
    const thumb = slide.querySelector('.card-thumb');
    const img = slide.querySelector('.card-thumb img');
    if (project.image) {
      img.src = project.image;
      img.alt = `${project.title} screenshot`;
      thumb.style.display = '';
    } else {
      thumb.style.display = 'none';
    }
    slide.querySelector('.tag').textContent = project.tag;
    slide.querySelector('.live-badge').style.visibility = project.href ? 'visible' : 'hidden';
    slide.querySelector('h3').textContent = project.title;
    slide.querySelector('p').textContent = project.description;
    slide.querySelector('.case-link').addEventListener('click', () => openCaseModal(project));
    const link = slide.querySelector('.demo-link');
    if (!project.linkText) {
      link.style.display = 'none';
    } else {
      link.style.display = '';
      link.textContent = project.linkText;
    }
    if (project.href) {
      link.href = project.href;
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
    } else {
      link.removeAttribute('href');
      link.removeAttribute('target');
      link.removeAttribute('rel');
    }
  }

  // Track order: [leading clones of the last w] + [real items] + [trailing clones of the first w]
  const order = [];
  for (let i = N - w; i < N; i++) order.push(i);
  for (let i = 0; i < N; i++) order.push(i);
  for (let i = 0; i < w; i++) order.push(i);

  const slideEls = order.map((projectIndex) => {
    const slide = buildSlide();
    fillSlide(slide, PROJECTS[projectIndex]);
    track.appendChild(slide);
    return slide;
  });

  PROJECTS.forEach((_, i) => {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.setAttribute('aria-label', `Show project ${i + 1}`);
    dot.addEventListener('click', () => { goTo(w + i); restart(); });
    dotsWrap.appendChild(dot);
  });
  const dots = Array.from(dotsWrap.children);

  let index = w; // first real item
  let animating = false;
  let autoplayTimer = null;

  function stepPx() {
    return slideEls[0].getBoundingClientRect().width + CAROUSEL_GAP;
  }

  function apply(withTransition) {
    track.style.transition = withTransition ? 'transform 0.6s cubic-bezier(0.22, 0.8, 0.32, 1)' : 'none';
    track.style.transform = `translateX(-${index * stepPx()}px)`;
  }

  function updateDots() {
    const realIndex = ((index - w) % N + N) % N;
    dots.forEach((d, i) => d.classList.toggle('active', i === realIndex));
  }

  function goTo(newIndex) {
    if (animating || N <= 1) return;
    animating = true;
    index = newIndex;
    apply(true);
    updateDots();
  }

  track.addEventListener('transitionend', (e) => {
    if (e.propertyName !== 'transform') return;
    animating = false;
    if (index >= w + N) { index -= N; apply(false); }
    else if (index < w) { index += N; apply(false); }
  });

  function next() { goTo(index + 1); }
  function prev() { goTo(index - 1); }

  function stop() {
    if (autoplayTimer) { clearInterval(autoplayTimer); autoplayTimer = null; }
  }
  function start() {
    stop();
    if (prefersReducedMotion || N <= 1) return;
    autoplayTimer = setInterval(next, 3000);
  }
  function restart() {
    if (panelsMap.work && panelsMap.work.classList.contains('active')) start();
  }

  prevBtn.addEventListener('click', () => { prev(); restart(); });
  nextBtn.addEventListener('click', () => { next(); restart(); });
  rotator.addEventListener('mouseenter', stop);
  rotator.addEventListener('mouseleave', restart);
  window.addEventListener('resize', () => apply(false));

  apply(false);
  updateDots();
  carouselApi = { start, stop, restart };
}

// -------------------------------------------------------------------------
// Contact form: no backend on GitHub Pages, so this posts to FormSubmit's
// AJAX endpoint (formsubmit.co) using the real inbox address — no signup
// required, but FormSubmit sends a one-time confirmation email on the
// very first submission that has to be clicked before messages actually
// arrive. Includes a hidden honeypot field as basic spam protection.
// -------------------------------------------------------------------------
function setupContactForm() {
  const form = document.getElementById('contactForm');
  const statusEl = document.getElementById('formStatus');
  if (!form || !statusEl) return;

  const submitBtn = form.querySelector('.form-submit');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const honey = form.querySelector('[name="_honey"]').value;
    if (honey) return; // bot filled the hidden field — silently drop

    const name = form.querySelector('#cf-name').value.trim();
    const email = form.querySelector('#cf-email').value.trim();
    const message = form.querySelector('#cf-message').value.trim();

    if (!name || !email || !message) {
      statusEl.textContent = 'Please fill in all fields.';
      statusEl.className = 'form-status error';
      return;
    }

    submitBtn.disabled = true;
    statusEl.textContent = 'Sending…';
    statusEl.className = 'form-status pending';

    try {
      const res = await fetch('https://formsubmit.co/ajax/abirmehmed@gmail.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ name, email, message, _subject: 'New message from your portfolio' })
      });
      if (!res.ok) throw new Error('Request failed');
      statusEl.textContent = "Sent — I'll get back to you soon.";
      statusEl.className = 'form-status success';
      form.reset();
    } catch (err) {
      statusEl.textContent = 'Something went wrong — try the email link below instead.';
      statusEl.className = 'form-status error';
    } finally {
      submitBtn.disabled = false;
    }
  });
}

// -------------------------------------------------------------------------
// Case-study modal: a single reusable dialog, populated from whichever
// project's "Details" button was clicked. Closes on Escape, backdrop
// click, or the close button, and returns focus to whatever triggered it.
// -------------------------------------------------------------------------
let caseModalLastFocus = null;

function openCaseModal(project) {
  const modal = document.getElementById('caseModal');
  if (!modal) return;

  const thumb = modal.querySelector('.case-modal-thumb');
  const img = modal.querySelector('.case-modal-thumb img');
  if (project.image) {
    img.src = project.image;
    img.alt = `${project.title} screenshot`;
    thumb.style.display = '';
  } else {
    thumb.style.display = 'none';
  }
  modal.querySelector('#caseModalTag').textContent = project.tag;
  modal.querySelector('#caseModalTitle').textContent = project.title;
  modal.querySelector('#caseModalDesc').textContent = project.description;

  const featuresEl = modal.querySelector('#caseModalFeatures');
  featuresEl.innerHTML = '';
  (project.features || []).forEach((f) => {
    const li = document.createElement('li');
    li.textContent = f;
    featuresEl.appendChild(li);
  });

  const link = modal.querySelector('#caseModalLink');
  link.textContent = project.linkText;
  if (project.href) {
    link.href = project.href;
    link.style.display = '';
  } else {
    link.style.display = 'none';
  }

  caseModalLastFocus = document.activeElement;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  modal.querySelector('.case-modal-close').focus();
  document.addEventListener('keydown', onCaseModalKeydown);
}

function closeCaseModal() {
  const modal = document.getElementById('caseModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
  document.removeEventListener('keydown', onCaseModalKeydown);
  if (caseModalLastFocus) caseModalLastFocus.focus();
}

function onCaseModalKeydown(e) {
  if (e.key === 'Escape') closeCaseModal();
}

function setupCaseModal() {
  const modal = document.getElementById('caseModal');
  if (!modal) return;
  modal.querySelectorAll('[data-close]').forEach((el) => {
    el.addEventListener('click', closeCaseModal);
  });
}

// Adaptive quality: if FPS sustains low, quietly reduce the DPR cap.
let dprCap = Math.min(window.devicePixelRatio || 1, 2);
let lowFpsAccum = 0;

function maybeAdaptQuality(dt, fps) {
  if (dprCap <= 1.0) return;
  if (fps > 0 && fps < 32) {
    lowFpsAccum += dt;
    if (lowFpsAccum > 3.0) {
      dprCap = Math.max(1.0, dprCap - 0.25);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
      lowFpsAccum = 0;
      srLive.textContent = 'Reduced rendering resolution to maintain frame rate.';
    }
  } else {
    lowFpsAccum = Math.max(0, lowFpsAccum - dt * 2);
  }
}

// =========================================================================
// Main loop
// =========================================================================

const clock = new THREE.Clock();
let simTime = 0;
let fpsSmoothed = 0;
let fpsAccumTime = 0;
let fpsAccumFrames = 0;

function loop() {
  if (!running || disposed) return;
  requestAnimationFrame(loop);

  const rawDelta = clock.getDelta();
  const dt = Math.min(rawDelta, CLOCK_MAX_DELTA);

  simTime += dt;
  U.time.value = simTime;

  lightningEnvelope = Math.max(0, lightningEnvelope - dt * 2.2);
  U.lightningFlash.value = lightningEnvelope;

  if (timeTweenActive) {
    timeTweenElapsed += dt;
    const t = Math.min(1, timeTweenElapsed / TIME_TWEEN_DURATION);
    const value = THREE.MathUtils.lerp(timeTweenFrom, timeTweenTo, easeInOutCubic(t));
    timeOfDayInput.value = String(value);
    applyTimeOfDay(value);
    if (t >= 1) timeTweenActive = false;
  }

  // Idle camera drift: slow yaw around the target, pausing on user input.
  if (driftAmount > 0 && clock.elapsedTime - lastInteraction > IDLE_BEFORE_DRIFT) {
    const speed = driftAmount * 0.045; // rad/s at full drift
    const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
    const angle = speed * dt;
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    camera.position.copy(controls.target).add(offset);
  }

  controls.update();
  postProcessing.render();

  // FPS (rolling ~4x/sec update)
  fpsAccumTime += dt;
  fpsAccumFrames += 1;
  if (fpsAccumTime >= 0.25) {
    fpsSmoothed = fpsAccumFrames / fpsAccumTime;
    fpsVal.textContent = fpsSmoothed.toFixed(0);
    maybeAdaptQuality(fpsAccumTime, fpsSmoothed);
    fpsAccumTime = 0;
    fpsAccumFrames = 0;
  }
}

// -------------------------------------------------------------------------
window.addEventListener('beforeunload', () => { disposed = true; });

init();
