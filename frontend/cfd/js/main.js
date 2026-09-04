import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// --- State Management ---
let scene, camera, renderer, controls;
let activeMesh = null;
let activePoints = null;
let activeWireframe = null;
let activeGeometry = null; // Store geometry for volume recalculations
let gridHelper, axesHelper;
let activeStreamlineScene = null;
let streamlinesToggleActive = false;
let currentRenderMode = 'shaded'; // 'shaded' | 'wireframe' | 'points'
let activeFilename = null;
let activeUrl = null;
let activeFileKey = null;
let currentFrontalArea = 0;
let activeStage = 1;
let unlockedStages = new Set([1]);

const MPH_TO_MS = 0.44704;
const DEFAULT_RACE_SPEED_MPH = 30;
let raceSpeedMph = DEFAULT_RACE_SPEED_MPH;

function raceSpeedMs() {
  return raceSpeedMph * MPH_TO_MS;
}

// Authentication State
let idToken = localStorage.getItem('caucsim_id_token') || null;
let authMode = 'cognito'; // 'cognito'
let cognitoConfig = null;
let authSession = null;
let challengeEmail = null;
// Which face the shared auth form is currently showing. One of 'signin',
// 'newPassword' (Cognito's NEW_PASSWORD_REQUIRED challenge), 'forgotRequest'
// or 'forgotConfirm'.
let authFormMode = 'signin';
let resetEmail = null;



// Elements
const viewportContainer = document.getElementById('viewport-container');
const viewportPlaceholder = document.getElementById('viewport-placeholder');
const activeModelTitle = document.getElementById('active-model-title');
const activeModelStatus = document.getElementById('active-model-status');
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('file-input');
const progressBar = document.getElementById('upload-progress-bar');
const progressFill = progressBar.querySelector('.progress-fill');
const progressPercent = progressBar.querySelector('.progress-percent');
const progressFilename = progressBar.querySelector('.progress-filename');
const libraryList = document.getElementById('library-list');
const libraryEmpty = document.getElementById('library-empty');
const refreshBtn = document.getElementById('refresh-library-btn');

// Auth Elements
const authModal = document.getElementById('auth-modal');
const authForm = document.getElementById('auth-form');
const authEmail = document.getElementById('auth-email');
const authPassword = document.getElementById('auth-password');
const authError = document.getElementById('auth-error');
const btnLoginSubmit = document.getElementById('btn-login-submit');
const authNotice = document.getElementById('auth-notice');
const authNewPassword = document.getElementById('auth-new-password');
const authResetCode = document.getElementById('auth-reset-code');
const authResetPassword = document.getElementById('auth-reset-password');
const authForgotLink = document.getElementById('auth-forgot-link');
const authBackLink = document.getElementById('auth-back-link');
const authResendCodeLink = document.getElementById('auth-resend-code-link');
const btnLogout = document.getElementById('btn-logout');

// Stats Elements
const statTriangles = document.getElementById('stat-triangles');
const statVertices = document.getElementById('stat-vertices');
const statVolume = document.getElementById('stat-volume');
const statSurfaceArea = document.getElementById('stat-surface-area');
const statFrontalArea = document.getElementById('stat-frontal-area');
const dimLen = document.getElementById('dim-len');
const dimWid = document.getElementById('dim-wid');
const dimHei = document.getElementById('dim-hei');
const dimensionLabels = document.getElementById('dimension-labels');

// Regulations Check Elements
const regLen = document.getElementById('reg-len');
const regLenVal = document.getElementById('reg-len-val');
const regWid = document.getElementById('reg-wid');
const regWidVal = document.getElementById('reg-wid-val');
const regHei = document.getElementById('reg-hei');
const regHeiVal = document.getElementById('reg-hei-val');
const regWatertight = document.getElementById('reg-watertight');
const regWatertightVal = document.getElementById('reg-watertight-val');
const regCfdScale = document.getElementById('reg-cfd-scale');
const regCfdScaleVal = document.getElementById('reg-cfd-scale-val');
const regPosX = document.getElementById('reg-pos-x');
const regPosXVal = document.getElementById('reg-pos-x-val');
const regSymmetryY = document.getElementById('reg-symmetry-y');
const regSymmetryYVal = document.getElementById('reg-symmetry-y-val');
const regPosZ = document.getElementById('reg-pos-z');
const regPosZVal = document.getElementById('reg-pos-z-val');
const regSummary = document.getElementById('reg-summary');
const metaStatusContainer = document.getElementById('meta-status-container');
const metaStatusDot = document.getElementById('meta-status-dot');
const metaStatusText = document.getElementById('meta-status-text');

// Show login modal immediately if no token exists to prevent dashboard flashing
if (!idToken) {
  authModal.style.display = 'flex';
}

// --- Stage Management & Accordion Cards ---
function switchStage(stageNum) {
  if (!unlockedStages.has(stageNum)) {
    console.warn(`Stage ${stageNum} is currently locked.`);
    return;
  }

  // Reaching Stage 2 is what opens up the CFD stage: the user has to look at
  // the geometry checks before they can run a simulation. Unlocked before the
  // card/panel loops below so Stage 3 loses its disabled styling in this pass.
  if (stageNum === 2) {
    unlockStage(3);
  }

  activeStage = stageNum;
  
  // 1. Update left accordion cards styling
  for (let i = 1; i <= 4; i++) {
    const cardEl = document.getElementById(`card-stage-${i}`);
    if (cardEl) {
      if (i === activeStage) {
        cardEl.classList.add('active');
      } else {
        cardEl.classList.remove('active');
      }
      
      // Update disabled state based on unlock status
      if (unlockedStages.has(i)) {
        cardEl.classList.remove('disabled');
      } else {
        cardEl.classList.add('disabled');
      }
    }
  }
  
  // 2. Update right-side stage data panels visibility
  for (let i = 1; i <= 4; i++) {
    const panelEl = document.getElementById(`data-stage-${i}`);
    if (panelEl) {
      if (i === activeStage) {
        panelEl.style.display = 'flex';
        panelEl.classList.add('active');
      } else {
        panelEl.style.display = 'none';
        panelEl.classList.remove('active');
      }
    }
  }
  
  // 3. Stage 4's charts live in the right-hand summary panel, which was
  // display:none until the loop above -- SVG sizing measures clientWidth, so
  // render only once the panel is visible.
  if (activeStage === 4) {
    renderPerformanceCharts();
  }
}
window.switchStage = switchStage;

function unlockStage(stageNum) {
  unlockedStages.add(stageNum);
  const cardEl = document.getElementById(`card-stage-${stageNum}`);
  if (cardEl) {
    cardEl.classList.remove('disabled');
  }
}
window.unlockStage = unlockStage;

function lockStage(stageNum) {
  unlockedStages.delete(stageNum);
  const cardEl = document.getElementById(`card-stage-${stageNum}`);
  if (cardEl) {
    cardEl.classList.add('disabled');
  }
}
window.lockStage = lockStage;

// --- SVG Performance Charts Rendering ---
function renderPerformanceCharts() {
  const cdaVal = parseFloat(document.getElementById('cfd-cda').textContent) || 0.048;
  const claVal = parseFloat(document.getElementById('cfd-cla').textContent) || -0.019;
  
  const forcesWrapper = document.getElementById('forces-chart-svg');
  const powerWrapper = document.getElementById('power-chart-svg');
  
  if (!forcesWrapper || !powerWrapper) return;
  
  const w = forcesWrapper.clientWidth || 500;
  const h = forcesWrapper.clientHeight || 200;
  
  const padding = { left: 45, right: 15, top: 15, bottom: 30 };
  const graphW = w - padding.left - padding.right;
  const graphH = h - padding.top - padding.bottom;
  
  const density = 1.225; // kg/m³
  const vRace = raceSpeedMs();
  // Axis spans to the race speed with headroom, rounded up to a clean 5 m/s step
  const vMax = Math.max(20, Math.ceil((vRace * 1.5) / 5) * 5);
  const speeds = Array.from({ length: 11 }, (_, i) => (i * vMax) / 10);

  // 1. Forces Chart (Drag & Lift)
  const dragForces = speeds.map(v => 0.5 * density * v * v * cdaVal);
  const liftForces = speeds.map(v => 0.5 * density * v * v * claVal);
  
  const maxF = Math.max(...dragForces.map(Math.abs), ...liftForces.map(Math.abs), 5);
  const yMaxF = Math.ceil(maxF / 5) * 5;
  
  const mapForceCoords = (v, f) => {
    const x = padding.left + (v / vMax) * graphW;
    const y = padding.top + (1 - (f - (-yMaxF)) / (2 * yMaxF)) * graphH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };

  const dragPoints = speeds.map(v => mapForceCoords(v, 0.5 * density * v * v * cdaVal)).join(' ');
  const liftPoints = speeds.map(v => mapForceCoords(v, 0.5 * density * v * v * claVal)).join(' ');

  const raceDragY = 0.5 * density * vRace * vRace * cdaVal;
  const raceLiftY = 0.5 * density * vRace * vRace * claVal;
  const raceDragCoord = mapForceCoords(vRace, raceDragY);
  const raceLiftCoord = mapForceCoords(vRace, raceLiftY);

  const xRace = padding.left + (vRace / vMax) * graphW;
  
  forcesWrapper.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}">
      <defs>
        <linearGradient id="drag-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent-cyan)" stop-opacity="0.2"/>
          <stop offset="100%" stop-color="var(--accent-cyan)" stop-opacity="0"/>
        </linearGradient>
        <linearGradient id="lift-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--accent-purple)" stop-opacity="0.15"/>
          <stop offset="100%" stop-color="var(--accent-purple)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      
      <!-- Grid lines -->
      ${[ -yMaxF, -yMaxF / 2, 0, yMaxF / 2, yMaxF ].map(f => {
        const y = padding.top + (1 - (f - (-yMaxF)) / (2 * yMaxF)) * graphH;
        return `
          <line x1="${padding.left}" y1="${y}" x2="${w - padding.right}" y2="${y}" class="chart-grid-line" />
          <text x="${padding.left - 8}" y="${y + 3}" class="chart-label-text" text-anchor="end">${f.toFixed(1)}</text>
        `;
      }).join('')}
      
      ${[ 0, 0.25, 0.5, 0.75, 1 ].map(frac => {
        const v = frac * vMax;
        const x = padding.left + frac * graphW;
        return `
          <line x1="${x}" y1="${padding.top}" x2="${x}" y2="${h - padding.bottom}" class="chart-grid-line" />
          <text x="${x}" y="${h - padding.bottom + 14}" class="chart-label-text" text-anchor="middle">${v % 1 === 0 ? v : v.toFixed(1)}</text>
        `;
      }).join('')}

      <!-- Zero baseline -->
      <line x1="${padding.left}" y1="${padding.top + 0.5 * graphH}" x2="${w - padding.right}" y2="${padding.top + 0.5 * graphH}" class="chart-axis-line" stroke-dasharray="2 2" />
      
      <!-- Grid Border Axis -->
      <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${h - padding.bottom}" class="chart-axis-line" />
      <line x1="${padding.left}" y1="${h - padding.bottom}" x2="${w - padding.right}" y2="${h - padding.bottom}" class="chart-axis-line" />
      
      <!-- Area curves -->
      <path d="M${padding.left},${padding.top + 0.5 * graphH} L${dragPoints} L${w - padding.right},${padding.top + 0.5 * graphH} Z" class="chart-area-drag" />
      
      <!-- Lines -->
      <path d="M${dragPoints}" class="chart-line-drag" />
      <path d="M${liftPoints}" class="chart-line-lift" />
      
      <!-- Race Speed Vertical line indicator -->
      <line x1="${xRace}" y1="${padding.top}" x2="${xRace}" y2="${h - padding.bottom}" stroke="rgba(255,255,255,0.25)" stroke-width="1" stroke-dasharray="2 2" />
      
      <!-- Interactive Points at Race Speed -->
      <circle cx="${xRace}" cy="${raceDragCoord.split(',')[1]}" r="4.5" class="chart-marker chart-marker-drag" />
      <circle cx="${xRace}" cy="${raceLiftCoord.split(',')[1]}" r="4.5" class="chart-marker chart-marker-lift" />
      
      <!-- Legend -->
      <g transform="translate(${padding.left + 15}, ${padding.top + 10})">
        <rect x="0" y="0" width="8" height="8" fill="var(--accent-cyan)" rx="2"/>
        <text x="12" y="8" class="chart-label-text" style="fill:var(--text-primary);">Drag Force (N)</text>
        
        <rect x="110" y="0" width="8" height="8" fill="var(--accent-purple)" rx="2"/>
        <text x="122" y="8" class="chart-label-text" style="fill:var(--text-primary);">Lift Force (N)</text>
      </g>
      
      <!-- X Axis Label -->
      <text x="${padding.left + graphW / 2}" y="${h - 5}" class="chart-label-text" text-anchor="middle" style="font-size: 8.5px; fill: var(--text-secondary);">Velocity (m/s)</text>
    </svg>
  `;
  
  // 2. Power Chart (Power Required)
  const powerValues = speeds.map(v => {
    const dragF = 0.5 * density * v * v * cdaVal;
    return dragF * v;
  });
  
  const maxP = Math.max(...powerValues, 50);
  const yMaxP = Math.ceil(maxP / 50) * 50;
  
  const mapPowerCoords = (v, p) => {
    const x = padding.left + (v / vMax) * graphW;
    const y = padding.top + (1 - p / yMaxP) * graphH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };

  const powerPoints = speeds.map(v => {
    const dragF = 0.5 * density * v * v * cdaVal;
    return mapPowerCoords(v, dragF * v);
  }).join(' ');

  const racePowerY = raceDragY * vRace;
  const racePowerCoord = mapPowerCoords(vRace, racePowerY);
  
  powerWrapper.innerHTML = `
    <svg viewBox="0 0 ${w} ${h}">
      <defs>
        <linearGradient id="power-gradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ff9d00" stop-opacity="0.2"/>
          <stop offset="100%" stop-color="#ff9d00" stop-opacity="0"/>
        </linearGradient>
      </defs>
      
      <!-- Grid lines -->
      ${[ 0, yMaxP / 4, yMaxP / 2, (3 * yMaxP) / 4, yMaxP ].map(p => {
        const y = padding.top + (1 - p / yMaxP) * graphH;
        return `
          <line x1="${padding.left}" y1="${y}" x2="${w - padding.right}" y2="${y}" class="chart-grid-line" />
          <text x="${padding.left - 8}" y="${y + 3}" class="chart-label-text" text-anchor="end">${p.toFixed(0)}</text>
        `;
      }).join('')}
      
      ${[ 0, 0.25, 0.5, 0.75, 1 ].map(frac => {
        const v = frac * vMax;
        const x = padding.left + frac * graphW;
        return `
          <line x1="${x}" y1="${padding.top}" x2="${x}" y2="${h - padding.bottom}" class="chart-grid-line" />
          <text x="${x}" y="${h - padding.bottom + 14}" class="chart-label-text" text-anchor="middle">${v % 1 === 0 ? v : v.toFixed(1)}</text>
        `;
      }).join('')}

      <!-- Grid Border Axis -->
      <line x1="${padding.left}" y1="${padding.top}" x2="${padding.left}" y2="${h - padding.bottom}" class="chart-axis-line" />
      <line x1="${padding.left}" y1="${h - padding.bottom}" x2="${w - padding.right}" y2="${h - padding.bottom}" class="chart-axis-line" />

      <!-- Area curve -->
      <path d="M${padding.left},${h - padding.bottom} L${powerPoints} L${w - padding.right},${h - padding.bottom} Z" class="chart-area-power" />
      
      <!-- Line -->
      <path d="M${powerPoints}" class="chart-line-power" />
      
      <!-- Race Speed Vertical line indicator -->
      <line x1="${xRace}" y1="${padding.top}" x2="${xRace}" y2="${h - padding.bottom}" stroke="rgba(255,255,255,0.25)" stroke-width="1" stroke-dasharray="2 2" />
      
      <!-- Interactive Point at Race Speed -->
      <circle cx="${xRace}" cy="${racePowerCoord.split(',')[1]}" r="4.5" class="chart-marker chart-marker-power" />
      
      <!-- Legend -->
      <g transform="translate(${padding.left + 15}, ${padding.top + 10})">
        <rect x="0" y="0" width="8" height="8" fill="#ff9d00" rx="2"/>
        <text x="12" y="8" class="chart-label-text" style="fill:var(--text-primary);">Aero Power Required (W)</text>
      </g>
      
      <!-- X Axis Label -->
      <text x="${padding.left + graphW / 2}" y="${h - 5}" class="chart-label-text" text-anchor="middle" style="font-size: 8.5px; fill: var(--text-secondary);">Velocity (m/s)</text>
    </svg>
  `;
}
window.renderPerformanceCharts = renderPerformanceCharts;

// Window resize handler for performance charts
window.addEventListener('resize', () => {
  if (activeStage === 4) {
    renderPerformanceCharts();
  }
});

// Helper function to reset active model states
function resetActiveGeometry() {
  clearActiveGeometry();
  
  const btnAnalyseGeometry = document.getElementById('btn-analyse-geometry');
  if (btnAnalyseGeometry) {
    btnAnalyseGeometry.disabled = true;
  }
  
  viewportPlaceholder.style.display = 'flex';
  dimensionLabels.style.display = 'none';
  activeModelTitle.textContent = 'No Geometry Loaded';
  activeModelStatus.style.display = 'none';
  activeFileKey = null;
  activeFilename = null;
  activeUrl = null;
  
  // Clear Stats UI
  statTriangles.textContent = '-';
  statVertices.textContent = '-';
  statVolume.textContent = '-';
  statSurfaceArea.textContent = '-';
  statFrontalArea.textContent = '-';
  currentFrontalArea = 0;
  dimLen.textContent = '-';
  dimWid.textContent = '-';
  dimHei.textContent = '-';
  regLenVal.textContent = '-';
  regWidVal.textContent = '-';
  regHeiVal.textContent = '-';
  regWatertightVal.textContent = 'Not Checked';
  regCfdScaleVal.textContent = 'Not Checked';
  if (regPosXVal) regPosXVal.textContent = 'Not Checked';
  if (regSymmetryYVal) regSymmetryYVal.textContent = 'Not Checked';
  if (regPosZVal) regPosZVal.textContent = 'Not Checked';
  if (metaStatusContainer) metaStatusContainer.style.color = 'var(--accent-cyan)';
  if (metaStatusDot) {
    metaStatusDot.style.backgroundColor = 'var(--accent-cyan)';
    metaStatusDot.style.filter = 'drop-shadow(0 0 3px var(--accent-cyan))';
  }
  if (metaStatusText) metaStatusText.textContent = 'Loaded & Ready';
  regSummary.textContent = 'No geometry loaded';
  regSummary.className = 'reg-summary-box';
  document.querySelectorAll('.reg-item').forEach(el => el.className = 'reg-item');
  
  // Reset Dynamic Stage Data Updates
  const detailsEmpty = document.getElementById('import-details-empty');
  const detailsLoaded = document.getElementById('import-details-loaded');
  const metaFilename = document.getElementById('meta-filename');
  if (detailsEmpty) detailsEmpty.style.display = 'flex';
  if (detailsLoaded) detailsLoaded.style.display = 'none';
  if (metaFilename) metaFilename.textContent = '-';

  // Lock stages 2, 3, and 4
  lockStage(2);
  lockStage(3);
  lockStage(4);
  switchStage(1);
}

// --- Custom 3D Prominent Axes Helper (Cylinders and Cones) ---
function createCustomAxesHelper(length = 200, thickness = 3.5) {
  const group = new THREE.Group();
  
  const arrowLength = length * 0.15;
  const shaftLength = length - arrowLength;
  
  const createAxis = (dir, colorHex) => {
    const axisGroup = new THREE.Group();
    
    // Shaft (Cylinder)
    const shaftGeom = new THREE.CylinderGeometry(thickness, thickness, shaftLength, 8);
    const material = new THREE.MeshBasicMaterial({
      color: colorHex,
      toneMapped: false,
      depthTest: false, // Make sure it renders on top of the grid/model for high visibility
      transparent: true,
      opacity: 0.95
    });
    const shaft = new THREE.Mesh(shaftGeom, material);
    shaft.renderOrder = 999; // Ensure it draws on top
    // Align cylinder (default stands on Y) to the target direction
    shaft.position.y = shaftLength / 2;
    axisGroup.add(shaft);
    
    // Tip (Cone)
    const coneGeom = new THREE.ConeGeometry(thickness * 2.5, arrowLength, 8);
    const cone = new THREE.Mesh(coneGeom, material);
    cone.renderOrder = 999;
    cone.position.y = shaftLength + arrowLength / 2;
    axisGroup.add(cone);
    
    // Rotate axis group to match direction vector
    if (dir.x > 0) {
      axisGroup.rotation.z = -Math.PI / 2; // Orient along X (Red)
    } else if (dir.z > 0) {
      axisGroup.rotation.x = Math.PI / 2;  // Orient along Z (Blue)
    } // Y is default (Green)
    
    return axisGroup;
  };
  
  // Red X (Length)
  group.add(createAxis(new THREE.Vector3(1, 0, 0), 0xff3333));
  // Green Y (Width)
  group.add(createAxis(new THREE.Vector3(0, 1, 0), 0x33ff33));
  // Blue Z (Height)
  group.add(createAxis(new THREE.Vector3(0, 0, 1), 0x3333ff));
  
  return group;
}

// --- Three.js Scene Setup ---
function initThree() {
  const width = viewportContainer.clientWidth;
  const height = viewportContainer.clientHeight;

  // Scene
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x06090f);

  // Camera (expanded far plane to 25000 for Z-up coordinate system)
  camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 25000);
  camera.up.set(0, 0, 1); // Set Z as vertical (UP) axis
  camera.position.set(2000, -3500, 1500); // Quarter isometric perspective
  
  // Camera Headlight (moves with camera to keep visible surfaces well-lit)
  const headlight = new THREE.DirectionalLight(0xffffff, 0.95);
  headlight.position.set(0, 0, 1); // Point directly ahead from camera focal point
  camera.add(headlight);
  scene.add(camera); // Must add camera to scene for child light to translate


  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setSize(width, height);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  viewportContainer.appendChild(renderer.domElement);

  // Controls (increased max distance to allow zooming out on 2-3m models)
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.05;
  controls.maxPolarAngle = Math.PI / 2 + 0.1; // Limit panning below ground slightly
  controls.minDistance = 50;
  controls.maxDistance = 15000;

  // Lights
  const ambientLight = new THREE.AmbientLight(0x1d283d, 1.2);
  scene.add(ambientLight);

  const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0x111622, 0.7);
  scene.add(hemisphereLight);

  // Directional Light with expanded shadow camera frustum for full-scale cars
  const dirLight1 = new THREE.DirectionalLight(0x00f0ff, 1.6);
  dirLight1.position.set(1500, 3000, 1500);
  dirLight1.castShadow = true;
  dirLight1.shadow.mapSize.width = 2048;
  dirLight1.shadow.mapSize.height = 2048;
  dirLight1.shadow.camera.near = 0.5;
  dirLight1.shadow.camera.far = 10000;
  
  const d = 3000; // 3-meter box for vehicle shadow containment
  dirLight1.shadow.camera.left = -d;
  dirLight1.shadow.camera.right = d;
  dirLight1.shadow.camera.top = d;
  dirLight1.shadow.camera.bottom = -d;
  scene.add(dirLight1);

  const dirLight2 = new THREE.DirectionalLight(0x8a2be2, 0.9);
  dirLight2.position.set(-1500, 2500, -1500);
  scene.add(dirLight2);

  // Helpers (expanded grid to 10m x 10m, rotated to lie on X-Y plane for Z-up system)
  gridHelper = new THREE.GridHelper(10000, 100, 0x00f0ff, 0x162135);
  gridHelper.rotation.x = Math.PI / 2; // Rotate Grid helper to align with X-Y plane
  gridHelper.position.z = 0;
  scene.add(gridHelper);

  axesHelper = createCustomAxesHelper(250, 4);
  // Position exactly at the origin to visualize nose coordinates
  axesHelper.position.set(0, 0, 0);
  scene.add(axesHelper);

  // Handle Resize
  window.addEventListener('resize', onWindowResize);

  // Animation Loop
  animate();
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

function onWindowResize() {
  const width = viewportContainer.clientWidth;
  const height = viewportContainer.clientHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}

// --- STL Loading & Calculations ---
function loadSTL(originalName, viewUrl, fileKey) {
  if (fileKey !== activeFileKey) {
    clearCfdRun();
  }

  activeFilename = originalName;
  activeUrl = viewUrl;
  activeFileKey = fileKey;

  // Reset previous object from scene
  clearActiveGeometry();
  
  // Hide placeholder, show labels
  viewportPlaceholder.style.display = 'none';
  dimensionLabels.style.display = 'flex';
  activeModelTitle.textContent = originalName;
  activeModelStatus.style.display = 'inline-block';
  
  // Update selection in list UI
  document.querySelectorAll('.model-item').forEach(item => {
    if (item.dataset.filekey === fileKey) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Dynamic Stage Data Updates
  const detailsEmpty = document.getElementById('import-details-empty');
  const detailsLoaded = document.getElementById('import-details-loaded');
  const metaFilename = document.getElementById('meta-filename');
  if (detailsEmpty) detailsEmpty.style.display = 'none';
  if (detailsLoaded) detailsLoaded.style.display = 'block';
  if (metaFilename) metaFilename.textContent = originalName;

  // Unlock Stage 2 but stay on Stage 1
  unlockStage(2);
  const btnAnalyseGeometry = document.getElementById('btn-analyse-geometry');
  if (btnAnalyseGeometry) {
    btnAnalyseGeometry.disabled = false;
  }
  switchStage(1);

  const loader = new STLLoader();
  
  // Show a loading text in title
  activeModelTitle.innerHTML = `Loading 3D mesh... <span style="font-size:11px; opacity:0.7;">(${originalName})</span>`;

  // Set status indicator to loading state
  if (metaStatusContainer) metaStatusContainer.style.color = 'var(--warning-color)';
  if (metaStatusDot) {
    metaStatusDot.style.backgroundColor = 'var(--warning-color)';
    metaStatusDot.style.filter = 'drop-shadow(0 0 3px var(--warning-color))';
  }
  if (metaStatusText) metaStatusText.textContent = 'Loading...';

  loader.load(
    viewUrl,
    (geometry) => {
      // Calculate unit scaling if necessary (Auto-detect or manual Meter scaling)
      geometry.computeBoundingBox();
      const tempSize = new THREE.Vector3();
      geometry.boundingBox.getSize(tempSize);
      const maxDimUnit = Math.max(tempSize.x, tempSize.y, tempSize.z);

      const unitSelect = document.getElementById('unit-select');
      const selectedUnit = unitSelect ? unitSelect.value : 'm';
      let scaleFactor = 1.0;

      if (selectedUnit === 'm' || selectedUnit === 'auto') {
        scaleFactor = 1000.0;
      } else if (selectedUnit === 'cm') {
        scaleFactor = 10.0;
      } else if (selectedUnit === 'in') {
        scaleFactor = 25.4;
      }

      if (scaleFactor !== 1.0) {
        geometry.scale(scaleFactor, scaleFactor, scaleFactor);
      }

      activeGeometry = geometry;
      
      // Calculate normal vectors if not present
      if (!geometry.attributes.normal) {
        geometry.computeVertexNormals();
      }

      // Set original file name for title
      activeModelTitle.textContent = originalName;

      // Create Shaded mesh
      // Using standard metallic bright silver-aluminum material for clear visibility
      const material = new THREE.MeshStandardMaterial({
        color: 0xdae4f0, // Sleek bright silver-aluminum
        roughness: 0.35,
        metalness: 0.25,
        flatShading: false,
        side: THREE.DoubleSide
      });
      activeMesh = new THREE.Mesh(geometry, material);
      activeMesh.castShadow = true;
      activeMesh.receiveShadow = true;

      // Create Wireframe representation
      const wireframeMaterial = new THREE.MeshBasicMaterial({
        color: 0x8a2be2,
        wireframe: true,
        transparent: true,
        opacity: 0.4
      });
      activeWireframe = new THREE.Mesh(geometry, wireframeMaterial);

      // Create Points (Point Cloud) representation
      const pointsMaterial = new THREE.PointsMaterial({
        color: 0x00f0ff,
        size: 1.2,
        sizeAttenuation: true
      });
      activePoints = new THREE.Points(geometry, pointsMaterial);

      // Remove geometry.center() to preserve exact CAD origin (critical for CFD analysis)
      geometry.computeBoundingBox();
      const boundingBox = geometry.boundingBox;
      
      const size = new THREE.Vector3();
      boundingBox.getSize(size);
      
      const center = new THREE.Vector3();
      boundingBox.getCenter(center);
      
      // Keep model positions at world origin (preserves CAD coordinate origin!)
      activeMesh.position.set(0, 0, 0);
      activeWireframe.position.set(0, 0, 0);
      activePoints.position.set(0, 0, 0);

      // Snap the ground grid to the bottom of the vehicle (min world Z)
      gridHelper.position.z = boundingBox.min.z;

      // Add to scene based on current rendering mode
      updateRenderMode();

      // Fit Camera to Model
      const maxDim = Math.max(size.x, size.y, size.z);
      const fov = camera.fov * (Math.PI / 180);
      let cameraDist = Math.abs(maxDim / 2 / Math.tan(fov / 2)) * 1.35; // zoom out slightly
      
      camera.position.set(
        center.x + cameraDist * 0.8,
        center.y - cameraDist * 1.0,
        center.z + cameraDist * 0.5
      );
      camera.lookAt(center);
      controls.target.copy(center);
      controls.update();

      // Compute statistics
      computeStats(geometry, size);

      // Set status to Loaded & Ready
      if (metaStatusContainer) metaStatusContainer.style.color = 'var(--accent-cyan)';
      if (metaStatusDot) {
        metaStatusDot.style.backgroundColor = 'var(--accent-cyan)';
        metaStatusDot.style.filter = 'drop-shadow(0 0 3px var(--accent-cyan))';
      }
      if (metaStatusText) metaStatusText.textContent = 'Loaded & Ready';
    },
    (xhr) => {
      // Progress handler
      if (xhr.lengthComputable) {
        const percent = Math.round((xhr.loaded / xhr.total) * 100);
        if (metaStatusText) metaStatusText.textContent = `Loading (${percent}%)...`;
      } else {
        if (metaStatusText) metaStatusText.textContent = 'Loading...';
      }
    },
    (err) => {
      console.error(err);
      activeModelTitle.textContent = 'Error rendering 3D file';
      if (metaStatusContainer) metaStatusContainer.style.color = 'var(--danger-color)';
      if (metaStatusDot) {
        metaStatusDot.style.backgroundColor = 'var(--danger-color)';
        metaStatusDot.style.filter = 'drop-shadow(0 0 3px var(--danger-color))';
      }
      if (metaStatusText) metaStatusText.textContent = 'Error Loading Mesh';
      alert('Error loading 3D STL file. The file may be corrupted.');
    }
  );
}

function clearActiveGeometry() {
  if (activeMesh) scene.remove(activeMesh);
  if (activeWireframe) scene.remove(activeWireframe);
  if (activePoints) scene.remove(activePoints);
  
  activeMesh = null;
  activeWireframe = null;
  activePoints = null;
  activeGeometry = null;
}

function updateRenderMode() {
  if (!activeMesh) return;
  
  // Remove all first
  scene.remove(activeMesh);
  scene.remove(activeWireframe);
  scene.remove(activePoints);
  
  if (currentRenderMode === 'shaded') {
    scene.add(activeMesh);
  } else if (currentRenderMode === 'wireframe') {
    scene.add(activeWireframe);
  } else if (currentRenderMode === 'points') {
    scene.add(activePoints);
  }
}

// --- Geometry Statistics Computation ---
function computeStats(geometry, size) {
  // Count vertices & triangles
  const vertices = geometry.attributes.position.count;
  const triangles = geometry.index ? geometry.index.count / 3 : vertices / 3;

  statTriangles.textContent = triangles.toLocaleString();
  statVertices.textContent = vertices.toLocaleString();

  // Bounding box size: STL standard assumes millimeters (mm)
  // CAD mapping: X = Length, Y = Width, Z = Height
  const l = size.x;
  const w = size.y;
  const h = size.z;

  dimLen.textContent = l.toFixed(1);
  dimHei.textContent = h.toFixed(1);
  dimWid.textContent = w.toFixed(1);

  // Bounding box volume (mm³ -> cm³)
  const boxVolumeCm3 = (l * h * w) / 1000;
  statVolume.innerHTML = `${boxVolumeCm3.toLocaleString(undefined, {maximumFractionDigits: 1})} <span class="unit">cm³</span>`;

  // Surface Area Calculation (exact)
  const surfaceAreaMm2 = calculateSurfaceArea(geometry);
  const surfaceAreaCm2 = surfaceAreaMm2 / 100;
  statSurfaceArea.innerHTML = `${surfaceAreaCm2.toLocaleString(undefined, {maximumFractionDigits: 1})} <span class="unit">cm²</span>`;

  // Watertight Mesh signed volume (exact)
  const volumeMm3 = calculateVolume(geometry);
  const volumeCm3 = volumeMm3 / 1000;

  // Compute Projected Frontal Area (Y-Z plane projection)
  const frontalAreaM2 = calculateFrontalArea(geometry, size);
  statFrontalArea.textContent = frontalAreaM2.toFixed(4);
  currentFrontalArea = frontalAreaM2;

  // Watertight status
  const isWatertight = volumeCm3 > 0.01; // basic validation
  regWatertightVal.textContent = isWatertight ? 'Pass' : 'Warning (Open Mesh)';
  if (isWatertight) {
    regWatertight.className = 'reg-item pass';
  } else {
    regWatertight.className = 'reg-item fail';
  }

  // F24 Regulations Checks
  // Max Length: 2400 mm
  regLenVal.textContent = `${l.toFixed(1)} mm`;
  if (l <= 2400) {
    regLen.className = 'reg-item pass';
  } else {
    regLen.className = 'reg-item fail';
  }

  // Max Width: 900 mm
  regWidVal.textContent = `${w.toFixed(1)} mm`;
  if (w <= 900) {
    regWid.className = 'reg-item pass';
  } else {
    regWid.className = 'reg-item fail';
  }

  // Height context warning (usually F24 cars are < 1000mm)
  regHeiVal.textContent = `${h.toFixed(1)} mm`;
  if (h <= 1200) {
    regHei.className = 'reg-item pass';
  } else {
    regHei.className = 'reg-item fail';
  }

  // CFD Scale Check (Meters)
  const unitSelect = document.getElementById('unit-select');
  const selectedUnit = unitSelect ? unitSelect.value : 'm';
  
  let scaleStatus = 'pass';
  let scaleReason = 'Pass';
  
  if (selectedUnit !== 'm') {
    scaleStatus = 'fail';
    scaleReason = `Warning: Model unit is ${selectedUnit.toUpperCase()}. CFD solver requires model to be in meters.`;
  } else {
    // If unit is meters, check if dimensions look like mm (e.g. length > 10m)
    if (l > 10000 || w > 10000 || h > 10000) {
      scaleStatus = 'fail';
      scaleReason = 'Warning: Model dimensions look too large. Raw STL coordinates are likely in millimeters instead of meters.';
    } else {
      scaleReason = 'Pass (Verified)';
    }
  }
  
  if (regCfdScale && regCfdScaleVal) {
    regCfdScaleVal.textContent = scaleReason;
    if (scaleStatus === 'pass') {
      regCfdScale.className = 'reg-item pass';
    } else {
      regCfdScale.className = 'reg-item fail';
    }
  }

  // Geometry alignment and orientation checks
  if (!geometry.boundingBox) {
    geometry.computeBoundingBox();
  }
  const min = geometry.boundingBox.min;
  const max = geometry.boundingBox.max;

  // 1. X Position Check: model is positioned between x=0 and x=model length
  const isXAligned = Math.abs(min.x) <= 5.0;
  if (regPosX && regPosXVal) {
    regPosXVal.textContent = isXAligned ? `Pass (${min.x.toFixed(1)} mm)` : `Fail (${min.x.toFixed(1)} mm)`;
    regPosX.className = isXAligned ? 'reg-item pass' : 'reg-item fail';
  }

  // 2. Y Symmetry Check: model is approximately symmetrical about y (a few mm tolerance)
  const yCenter = (min.y + max.y) / 2;
  const isYSymmetrical = Math.abs(yCenter) <= 5.0;
  if (regSymmetryY && regSymmetryYVal) {
    regSymmetryYVal.textContent = isYSymmetrical ? `Pass (${Math.abs(yCenter).toFixed(1)} mm offset)` : `Fail (${Math.abs(yCenter).toFixed(1)} mm offset)`;
    regSymmetryY.className = isYSymmetrical ? 'reg-item pass' : 'reg-item fail';
  }

  // 3. Z Ground Placement Check: model is above and on z=0 plane (wheels slightly below z=0 but not above)
  const isZAligned = min.z <= 0.5 && min.z >= -15.0;
  if (regPosZ && regPosZVal) {
    regPosZVal.textContent = isZAligned ? `Pass (${min.z.toFixed(1)} mm)` : `Fail (${min.z.toFixed(1)} mm)`;
    regPosZ.className = isZAligned ? 'reg-item pass' : 'reg-item fail';
  }

  // Overall regulations validation summary
  const isScaleOk = (scaleStatus === 'pass');
  if (l <= 2400 && w <= 900 && isWatertight && isScaleOk && isXAligned && isYSymmetrical && isZAligned) {
    regSummary.textContent = 'PASSED F24 DIMENSIONAL LIMITS';
    regSummary.className = 'reg-summary-box pass';
  } else {
    let reasons = [];
    if (l > 2400) reasons.push('Length exceeds limit');
    if (w > 900) reasons.push('Width exceeds limit');
    if (!isWatertight) reasons.push('Mesh not watertight');
    if (!isScaleOk) reasons.push('CFD scale not in meters');
    if (!isXAligned) reasons.push('X position offset');
    if (!isYSymmetrical) reasons.push('Y asymmetry');
    if (!isZAligned) reasons.push('Z ground mismatch');
    regSummary.textContent = 'FAILED RULES: ' + reasons.join(' & ');
    regSummary.className = 'reg-summary-box fail';
  }

  // Stage 3 is deliberately NOT unlocked here. Completing the checks only
  // makes Stage 2 worth reading; the user has to actually visit Stage 2
  // before the CFD stage opens up (see switchStage).
}

function calculateSurfaceArea(geometry) {
  let area = 0;
  const position = geometry.attributes.position;
  const index = geometry.index;
  const faces = index ? index.count / 3 : position.count / 3;
  
  const vA = new THREE.Vector3();
  const vB = new THREE.Vector3();
  const vC = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const cross = new THREE.Vector3();

  for (let i = 0; i < faces; i++) {
    let i0 = index ? index.getX(i * 3) : i * 3;
    let i1 = index ? index.getX(i * 3 + 1) : i * 3 + 1;
    let i2 = index ? index.getX(i * 3 + 2) : i * 3 + 2;
    
    vA.fromBufferAttribute(position, i0);
    vB.fromBufferAttribute(position, i1);
    vC.fromBufferAttribute(position, i2);
    
    ab.subVectors(vB, vA);
    ac.subVectors(vC, vA);
    cross.crossVectors(ab, ac);
    
    area += cross.length() * 0.5;
  }
  return area;
}

function calculateVolume(geometry) {
  let volume = 0;
  const position = geometry.attributes.position;
  const index = geometry.index;
  const faces = index ? index.count / 3 : position.count / 3;

  for (let i = 0; i < faces; i++) {
    let i0 = index ? index.getX(i * 3) : i * 3;
    let i1 = index ? index.getX(i * 3 + 1) : i * 3 + 1;
    let i2 = index ? index.getX(i * 3 + 2) : i * 3 + 2;
    
    const x0 = position.getX(i0), y0 = position.getY(i0), z0 = position.getZ(i0);
    const x1 = position.getX(i1), y1 = position.getY(i1), z1 = position.getZ(i1);
    const x2 = position.getX(i2), y2 = position.getY(i2), z2 = position.getZ(i2);
    
    // Signed volume formula of tetrahedron formed by face and origin
    const v321 = x0 * y1 * z2;
    const v231 = x1 * y0 * z2;
    const v312 = x0 * y2 * z1;
    const v132 = x2 * y0 * z1;
    const v213 = x1 * y2 * z0;
    const v123 = x2 * y1 * z0;
    
    volume += (-v321 + v231 + v312 - v132 - v213 + v123) / 6.0;
  }
  return Math.abs(volume);
}

function calculateFrontalArea(geometry, size) {
  const width = size.y; // Y is width
  const height = size.z; // Z is height
  
  if (width <= 0 || height <= 0) return 0;

  const position = geometry.attributes.position;
  const index = geometry.index;
  const faces = index ? index.count / 3 : position.count / 3;

  // Dynamic grid resolution to guarantee instant computation (< 15ms)
  let W_grid = 150;
  if (faces > 150000) W_grid = 80;
  else if (faces > 75000) W_grid = 110;

  const H_grid = Math.max(10, Math.min(300, Math.round(W_grid * (height / width))));
  const grid = new Uint8Array(W_grid * H_grid);
  const min = geometry.boundingBox.min;
  
  const isPointInTriangle = (px, py, x0, y0, x1, y1, x2, y2) => {
    const d1 = (px - x1) * (y0 - y1) - (x0 - x1) * (py - y1);
    const d2 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2);
    const d3 = (px - x0) * (y2 - y0) - (x2 - x0) * (py - y0);
    const has_neg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    const has_pos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    return !(has_neg && has_pos);
  };

  for (let i = 0; i < faces; i++) {
    let i0 = index ? index.getX(i * 3) : i * 3;
    let i1 = index ? index.getX(i * 3 + 1) : i * 3 + 1;
    let i2 = index ? index.getX(i * 3 + 2) : i * 3 + 2;

    // Projection on Y-Z plane (width / height)
    const u0 = position.getY(i0), v0 = position.getZ(i0);
    const u1 = position.getY(i1), v1 = position.getZ(i1);
    const u2 = position.getY(i2), v2 = position.getZ(i2);

    const x0 = Math.round(((u0 - min.y) / width) * (W_grid - 1));
    const y0 = Math.round(((v0 - min.z) / height) * (H_grid - 1));
    const x1 = Math.round(((u1 - min.y) / width) * (W_grid - 1));
    const y1 = Math.round(((v1 - min.z) / height) * (H_grid - 1));
    const x2 = Math.round(((u2 - min.y) / width) * (W_grid - 1));
    const y2 = Math.round(((v2 - min.z) / height) * (H_grid - 1));

    const minX = Math.max(0, Math.min(x0, x1, x2));
    const maxX = Math.min(W_grid - 1, Math.max(x0, x1, x2));
    const minY = Math.max(0, Math.min(y0, y1, y2));
    const maxY = Math.min(H_grid - 1, Math.max(y0, y1, y2));

    for (let py = minY; py <= maxY; py++) {
      for (let px = minX; px <= maxX; px++) {
        const idx = py * W_grid + px;
        if (grid[idx] === 1) continue;
        if (isPointInTriangle(px, py, x0, y0, x1, y1, x2, y2)) {
          grid[idx] = 1;
        }
      }
    }
  }

  let filledPixels = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === 1) filledPixels++;
  }

  const totalPixels = W_grid * H_grid;
  const bBoxAreaMm2 = width * height;
  const frontalAreaMm2 = (filledPixels / totalPixels) * bBoxAreaMm2;
  return frontalAreaMm2 / 1000000; // mm² -> m²
}

// --- API Service Calls ---
async function fetchLibrary(selectFileKey = null) {
  if (!idToken) return;
  try {
    const response = await fetch('/api/files', {
      headers: { 'Authorization': `Bearer ${idToken}` }
    });
    if (response.status === 401) {
      handleLogout();
      return;
    }
    if (!response.ok) throw new Error('Failed to load geometry library');
    
    const files = await response.json();
    renderLibraryList(files, selectFileKey);
  } catch (error) {
    console.error(error);
    libraryList.innerHTML = `<li class="loading-placeholder" style="color:var(--danger-color)">Error fetching models</li>`;
  }
}

function renderLibraryList(files, selectFileKey = null) {
  libraryList.innerHTML = '';
  
  if (files.length === 0) {
    libraryEmpty.style.display = 'block';
    return;
  }
  
  libraryEmpty.style.display = 'none';
  
  files.forEach(file => {
    const li = document.createElement('li');
    li.className = 'model-item';
    li.dataset.filekey = file.fileKey;
    
    // Check if it matches currently selected
    if (activeMesh && selectFileKey === file.fileKey) {
      li.classList.add('active');
    }
    
    const sizeKB = (file.size / 1024).toFixed(0);
    const dateStr = new Date(file.uploadedAt).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    li.innerHTML = `
      <div class="model-item-details">
        <span class="model-item-name" title="${file.originalName}">${file.originalName}</span>
        <div class="model-item-meta">
          <span>${sizeKB} KB</span>
          <span>•</span>
          <span>${dateStr}</span>
        </div>
      </div>
      <div class="model-item-actions">
        <button class="btn-icon btn-delete" title="Delete geometry">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>
    `;

    // Click handler to load mesh
    li.addEventListener('click', (e) => {
      if (e.target.closest('.btn-delete')) return;
      loadSTL(file.originalName, file.viewUrl, file.fileKey);
    });

    // Delete handler
    const deleteBtn = li.querySelector('.btn-delete');
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Are you sure you want to delete ${file.originalName}?`)) {
        try {
          // Send key directly. Express wildcard will catch uploads/... path.
          const deleteResponse = await fetch(`/api/files/${file.fileKey}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${idToken}` }
          });
          if (!deleteResponse.ok) throw new Error('Delete request failed');
          
          // If deleted file is active, reset scene
          if (activeFileKey === file.fileKey) {
            resetActiveGeometry();
          }
          
          fetchLibrary();
        } catch (err) {
          console.error(err);
          alert('Failed to delete geometry file.');
        }
      }
    });

    libraryList.appendChild(li);
  });

  // If a selectFileKey is specified, trigger load on it
  if (selectFileKey) {
    const matchedFile = files.find(f => f.fileKey === selectFileKey);
    if (matchedFile) {
      loadSTL(matchedFile.originalName, matchedFile.viewUrl, matchedFile.fileKey);
    }
  }
}

// --- Upload Logic ---
async function uploadFile(file) {
  if (!file.name.toLowerCase().endsWith('.stl')) {
    alert('Invalid format. Please upload a .stl file.');
    return;
  }

  progressBar.style.display = 'block';
  progressFill.style.width = '0%';
  progressPercent.textContent = '0%';
  progressFilename.textContent = file.name;

  try {
    // Phase 1: Retrieve presigned URLs
    const response = await fetch('/api/get-upload-url', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken}`
      },
      body: JSON.stringify({ filename: file.name, fileType: file.type || 'application/octet-stream' })
    });
    
    if (response.status === 401) {
      handleLogout();
      return;
    }
    if (!response.ok) throw new Error('Failed to generate presigned upload URL');
    const { uploadUrl, viewUrl, fileKey } = await response.json();

    // Instant Visualization: Load local blob instantly!
    const localBlobUrl = URL.createObjectURL(file);
    loadSTL(file.name, localBlobUrl, fileKey);

    // Phase 2: Direct upload to S3/Mock storage using raw PUT stream
    const xhr = new XMLHttpRequest();
    
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) {
        const percent = Math.round((e.loaded / e.total) * 100);
        progressFill.style.width = `${percent}%`;
        progressPercent.textContent = `${percent}%`;
      }
    });

    xhr.addEventListener('load', () => {
      progressBar.style.display = 'none';
      if (xhr.status === 200 || xhr.status === 201) {
        // Success! Clean up the local blob memory and refresh the library list.
        URL.revokeObjectURL(localBlobUrl);
        fetchLibrary(fileKey);
      } else {
        alert(`Storage upload failed: Status ${xhr.status}`);
      }
    });

    xhr.addEventListener('error', () => {
      progressBar.style.display = 'none';
      alert('Network error occurred during direct storage upload.');
    });

    xhr.open('PUT', uploadUrl);
    // Inject authorization token ONLY if uploading to our local mock server (relative path starts with /api/)
    if (uploadUrl.startsWith('/api/')) {
      xhr.setRequestHeader('Authorization', `Bearer ${idToken}`);
    }
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.send(file); // Stream the raw file directly as the HTTP body
  } catch (err) {
    console.error("Upload failure:", err);
    progressBar.style.display = 'none';
    alert(`Upload initialization failed: ${err.message}`);
  }
}

function updateRaceSpeedLabels() {
  const msDisplay = document.getElementById('race-speed-ms-display');
  if (msDisplay) msDisplay.textContent = raceSpeedMs().toFixed(1);
}

// Results labels track the speed the run was actually solved at, which is not
// necessarily the value currently sitting in the input.
function updateResultsSpeedLabels(mph) {
  const ms = mph * MPH_TO_MS;
  const combined = `${mph} mph / ${ms.toFixed(1)} m/s`;
  ['drag-force-speed-label', 'lift-force-speed-label'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = combined;
  });

  // Mirrors the droplet's VIS_SCALE_MAX so the legend matches the rendered image
  const visScaleMax = Math.ceil((ms * 1.5) / 5) * 5;
  const flowScaleEl = document.getElementById('flow-scale-max');
  if (flowScaleEl) flowScaleEl.textContent = visScaleMax;
}

// --- Event Listeners and Triggers ---
function bindEvents() {
  const raceSpeedInput = document.getElementById('race-speed-input');
  if (raceSpeedInput) {
    raceSpeedInput.value = raceSpeedMph;
    raceSpeedInput.addEventListener('input', () => {
      const parsed = parseFloat(raceSpeedInput.value);
      if (isNaN(parsed) || parsed <= 0) return;
      raceSpeedMph = Math.min(100, parsed);
      updateRaceSpeedLabels();
    });
    raceSpeedInput.addEventListener('change', () => {
      const parsed = parseFloat(raceSpeedInput.value);
      raceSpeedMph = (isNaN(parsed) || parsed <= 0) ? DEFAULT_RACE_SPEED_MPH : Math.min(100, parsed);
      raceSpeedInput.value = raceSpeedMph;
      updateRaceSpeedLabels();
    });
  }
  updateRaceSpeedLabels();
  updateResultsSpeedLabels(raceSpeedMph);

  // Drag and Drop
  ['dragenter', 'dragover'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
    }, false);
  });

  dropzone.addEventListener('drop', (e) => {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (files.length > 0) {
      uploadFile(files[0]);
    }
  });

  dropzone.addEventListener('click', () => {
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length > 0) {
      uploadFile(fileInput.files[0]);
    }
  });

  // Library Refresh
  refreshBtn.addEventListener('click', () => fetchLibrary());

  // Shading Modes
  document.querySelectorAll('[data-render-mode]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('[data-render-mode]').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      
      currentRenderMode = e.target.dataset.renderMode;
      updateRenderMode();
    });
  });

  // Camera Presets (Z-up coordinate mapping)
  document.querySelectorAll('[data-view]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      if (!activeMesh && !activeGeometry) return;
      
      activeGeometry.computeBoundingBox();
      const boundingBox = activeGeometry.boundingBox;
      const size = new THREE.Vector3();
      boundingBox.getSize(size);
      
      const center = new THREE.Vector3();
      boundingBox.getCenter(center);
      
      const maxDim = Math.max(size.x, size.y, size.z);
      const fov = camera.fov * (Math.PI / 180);
      let cameraDist = Math.abs(maxDim / 2 / Math.tan(fov / 2));
      cameraDist *= 1.35; // zoom out slightly

      controls.target.copy(center);
      
      const view = e.target.dataset.view;
      if (view === 'iso') {
        camera.position.set(center.x + cameraDist * 0.8, center.y - cameraDist * 1.0, center.z + cameraDist * 0.6);
      } else if (view === 'top') {
        // Looking down along Z axis
        camera.position.set(center.x, center.y + 0.001, center.z + cameraDist * 1.2);
      } else if (view === 'front') {
        // Facing nose (negative X coordinates looking towards center)
        camera.position.set(center.x - cameraDist * 1.2, center.y, center.z);
      } else if (view === 'side') {
        // Facing side (negative Y coordinates looking towards center)
        camera.position.set(center.x, center.y - cameraDist * 1.2, center.z);
      }
      
      controls.update();
    });
  });

  // Helper grid/axes toggles
  const toggleGridBtn = document.getElementById('toggle-grid');
  toggleGridBtn.addEventListener('click', () => {
    toggleGridBtn.classList.toggle('active');
    gridHelper.visible = toggleGridBtn.classList.contains('active');
  });

  const toggleAxesBtn = document.getElementById('toggle-axes');
  toggleAxesBtn.addEventListener('click', () => {
    toggleAxesBtn.classList.toggle('active');
    axesHelper.visible = toggleAxesBtn.classList.contains('active');
  });

  const toggleStreamlinesBtn = document.getElementById('toggle-streamlines');
  streamlinesToggleActive = toggleStreamlinesBtn.classList.contains('active');
  toggleStreamlinesBtn.addEventListener('click', () => {
    setStreamlinesVisible(!streamlinesToggleActive);
  });

  // Unit Mode Selector change
  const unitSelect = document.getElementById('unit-select');
  unitSelect.addEventListener('change', () => {
    if (activeFilename && activeUrl && activeFileKey) {
      loadSTL(activeFilename, activeUrl, activeFileKey);
    }
  });

  // Analyse Geometry button listener
  const btnAnalyseGeometry = document.getElementById('btn-analyse-geometry');
  if (btnAnalyseGeometry) {
    btnAnalyseGeometry.addEventListener('click', () => {
      switchStage(2);
    });
  }

  // Continue to Simulation button listener. Stage 3 was unlocked on arrival at
  // Stage 2, so this only moves the user along rather than gating.
  const btnContinueToCfd = document.getElementById('btn-continue-to-cfd');
  if (btnContinueToCfd) {
    btnContinueToCfd.addEventListener('click', () => {
      switchStage(3);
    });
  }

  // Initialize CFD Runner
  initCfdRunner();
}

async function checkStorageStatus() {
  const storageStatusEl = document.getElementById('storage-status');
  const storageStatusVal = document.getElementById('storage-status-val');
  
  if (!storageStatusEl || !storageStatusVal) return;

  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error();
    const data = await response.json();
    console.log("Status API Response:", data);
    
    // Parse Auth Configuration
    authMode = data.auth || 'aws-cognito';
    cognitoConfig = data.cognito || null;
    
    if (data.storage === 'aws-s3') {
      storageStatusEl.className = 'status-indicator online';
      storageStatusVal.textContent = 'AWS S3';
      storageStatusEl.title = `S3 Bucket: ${data.bucketName || 'unknown'}\nRegion: ${data.region || 'unknown'}`;
    } else {
      storageStatusEl.className = 'status-indicator offline';
      storageStatusVal.textContent = 'Disconnected';
      storageStatusEl.title = 'AWS S3 is not configured.';
    }

    validateSession();
  } catch (err) {
    console.error("Status fetch failed:", err);
    storageStatusEl.className = 'status-indicator offline';
    storageStatusVal.textContent = 'Disconnected';
    storageStatusEl.title = 'Could not connect to storage provider status API.';
    validateSession();
  }
}

function validateSession() {
  // If Cognito auth is enabled but we have a mock token in local storage, force a clean logout/re-auth
  if (authMode === 'cognito' && idToken && !idToken.includes('.')) {
    console.warn("Mock session token detected in Cognito mode. Forcing logout.");
    handleLogout();
  }

  if (idToken) {
    authModal.style.display = 'none';
    btnLogout.style.display = 'block';
    fetchLibrary();
  } else {
    authModal.style.display = 'flex';
    btnLogout.style.display = 'none';
  }
}

function handleLogout() {
  idToken = null;
  localStorage.removeItem('caucsim_id_token');

  // Reset the engine indicator. Callers can reach here mid-run (a 401 from
  // startCfdSimulation returns before its own error handling, and the poll
  // loop logs out on 401), which would otherwise strand the header showing a
  // live stage like "Preparing" while the user sits at the login modal.
  updateEngineStatus(null);
  showCfdMonitor(false);

  // Reset active geometry
  resetActiveGeometry();

  libraryList.innerHTML = '';
  libraryEmpty.style.display = 'block';

  // Reset auth form state and re-enable HTML validation on default inputs
  resetAuthForm();

  validateSession();
}

// The shared auth form has four faces; this is the submit label for each.
const AUTH_SUBMIT_LABELS = {
  signin: 'Sign In',
  newPassword: 'Confirm New Password',
  forgotRequest: 'Send Reset Code',
  forgotConfirm: 'Reset Password'
};

// Checked before we bother Cognito with an obviously short password. The pool's
// real policy is stricter and enforced server-side; its rejection text is shown
// verbatim because it spells out the actual requirements.
const MIN_PASSWORD_LENGTH = 8;

// Switch the auth form between sign-in, the first-run NEW_PASSWORD_REQUIRED
// challenge, and the two steps of the forgot-password flow.
function setAuthFormMode(mode) {
  authFormMode = mode;

  const isSignIn = mode === 'signin';
  const isNewPassword = mode === 'newPassword';
  const isForgotRequest = mode === 'forgotRequest';
  const isForgotConfirm = mode === 'forgotConfirm';

  const show = (el, visible, display) => {
    if (el) el.style.display = visible ? (display || 'flex') : 'none';
  };

  show(authEmail.closest('.form-group'), isSignIn || isForgotRequest);
  show(authPassword.closest('.form-group'), isSignIn);
  show(document.getElementById('reset-request-hint'), isForgotRequest);
  show(document.getElementById('reset-fields'), isForgotConfirm);
  show(document.getElementById('challenge-fields'), isNewPassword);
  show(document.getElementById('auth-forgot-row'), isSignIn, 'block');
  show(document.getElementById('auth-back-row'), isForgotRequest || isForgotConfirm, 'block');

  // Keep HTML validation in step with what is actually on screen: a hidden
  // input that is still `required` blocks submit with a bubble nobody can see.
  authEmail.required = isSignIn || isForgotRequest;
  authPassword.required = isSignIn;
  if (authNewPassword) authNewPassword.required = isNewPassword;
  if (authResetCode) authResetCode.required = isForgotConfirm;
  if (authResetPassword) authResetPassword.required = isForgotConfirm;

  btnLoginSubmit.disabled = false;
  btnLoginSubmit.textContent = AUTH_SUBMIT_LABELS[mode];
}

// Return the form to a clean sign-in state. Leaves the email field alone so a
// user who has just reset their password doesn't have to retype it.
function resetAuthForm() {
  authSession = null;
  challengeEmail = null;
  resetEmail = null;
  authPassword.value = '';
  if (authNewPassword) authNewPassword.value = '';
  if (authResetCode) authResetCode.value = '';
  if (authResetPassword) authResetPassword.value = '';
  clearAuthMessages();
  setAuthFormMode('signin');
}

function clearAuthMessages() {
  authError.style.display = 'none';
  if (authNotice) authNotice.style.display = 'none';
}

function showAuthNotice(msg) {
  if (!authNotice) return;
  authNotice.textContent = msg;
  authNotice.style.display = 'block';
}

// Cognito's user pool endpoint speaks AWS JSON 1.1: the operation name goes in
// X-Amz-Target, and failures come back as HTTP 400 with a `__type` of the form
// "com.amazon...#CodeMismatchException". These are the unauthenticated
// operations, so no request signing is involved and the browser can call them
// directly with only the public app client ID.
async function cognitoRequest(operation, body, fallbackMessage) {
  const response = await fetch(`https://cognito-idp.${cognitoConfig.region}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${operation}`
    },
    body: JSON.stringify(body)
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.message || fallbackMessage);
    err.code = String(data.__type || '').split('#').pop();
    throw err;
  }
  return data;
}

// Turn a Cognito reset error into something the user can act on. `stage` is
// 'request' or 'confirm' because InvalidParameterException means different
// things either side of the code being sent.
function resetErrorMessage(err, stage) {
  switch (err.code) {
    case 'NotAuthorizedException':
      return 'This account cannot reset its password this way. If you have never signed in, use the temporary password from your invitation email instead. Otherwise contact an administrator.';
    case 'InvalidParameterException':
      return stage === 'request'
        ? 'This account has no verified email address, so a reset code cannot be sent. Contact an administrator.'
        : (err.message || 'Password reset failed.');
    case 'CodeMismatchException':
      return 'That code is not correct. Check the email and try again.';
    case 'ExpiredCodeException':
      return 'That code has expired. Choose "Send a new code" to get another.';
    case 'PasswordHistoryPolicyViolationException':
      return 'Choose a password you have not used before.';
    case 'CodeDeliveryFailureException':
      return 'The reset code could not be delivered. Contact an administrator.';
    case 'LimitExceededException':
    case 'TooManyRequestsException':
    case 'TooManyFailedAttemptsException':
      return 'Too many attempts. Wait a few minutes and try again.';
    default:
      return err.message || 'Password reset failed.';
  }
}

// Ask Cognito to email a reset code. Resolves to the masked destination it
// reports (e.g. "a***@e***"), or null when we can't say.
async function requestPasswordReset(email) {
  try {
    const data = await cognitoRequest('ForgotPassword', {
      ClientId: cognitoConfig.clientId,
      Username: email
    }, 'Could not start the password reset.');

    resetEmail = email;
    return (data.CodeDeliveryDetails && data.CodeDeliveryDetails.Destination) || null;
  } catch (err) {
    // Never confirm or deny that an account exists: an unknown address gets the
    // same "code sent" screen as a real one. Cognito's own "prevent user
    // existence errors" option does this server-side, but it is a per-app-client
    // setting that can be switched off, so don't depend on it here.
    if (err.code === 'UserNotFoundException') {
      resetEmail = email;
      return null;
    }
    throw err;
  }
}

// Bind Auth UI event listeners
authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearAuthMessages();
  btnLoginSubmit.disabled = true;

  if (authFormMode === 'newPassword') {
    // Challenge response flow (Confirm new password)
    btnLoginSubmit.textContent = 'Confirming...';
    const newPassword = authNewPassword.value;
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
      showAuthError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
      return;
    }

    try {
      const data = await cognitoRequest('RespondToAuthChallenge', {
        ChallengeName: 'NEW_PASSWORD_REQUIRED',
        ClientId: cognitoConfig.clientId,
        ChallengeResponses: {
          USERNAME: challengeEmail,
          NEW_PASSWORD: newPassword
        },
        Session: authSession
      }, 'Password change failed.');

      // Success! Cognito returns tokens under AuthenticationResult
      handleLoginSuccess(data.AuthenticationResult.IdToken);
    } catch (err) {
      console.error("Password update error:", err);
      showAuthError(err.message || 'Failed to update password.');
    }
    return;
  }

  if (authFormMode === 'forgotRequest') {
    btnLoginSubmit.textContent = 'Sending...';
    const email = authEmail.value.trim();

    try {
      const destination = await requestPasswordReset(email);
      setAuthFormMode('forgotConfirm');
      document.getElementById('reset-destination-text').textContent = destination
        ? `We sent a code to ${destination}. Enter it below with your new password.`
        : 'If that account exists, a code is on its way. Enter it below with your new password.';
      showAuthNotice('Reset codes expire after 24 hours.');
      authResetCode.focus();
    } catch (err) {
      console.error("Password reset request error:", err);
      showAuthError(resetErrorMessage(err, 'request'));
    }
    return;
  }

  if (authFormMode === 'forgotConfirm') {
    const code = authResetCode.value.trim();
    const newPassword = authResetPassword.value;
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
      showAuthError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
      return;
    }

    btnLoginSubmit.textContent = 'Resetting...';
    try {
      await cognitoRequest('ConfirmForgotPassword', {
        ClientId: cognitoConfig.clientId,
        Username: resetEmail,
        ConfirmationCode: code,
        Password: newPassword
      }, 'Password reset failed.');

      // Cognito issues no tokens here, so drop the user back on the sign-in
      // form with their email still filled in.
      const email = resetEmail;
      resetAuthForm();
      authEmail.value = email;
      showAuthNotice('Password updated. Sign in with your new password.');
      authPassword.focus();
    } catch (err) {
      console.error("Password reset confirmation error:", err);
      showAuthError(resetErrorMessage(err, 'confirm'));
    }
    return;
  }

  // Normal Login Flow
  btnLoginSubmit.textContent = 'Signing in...';
  const email = authEmail.value.trim();
  const password = authPassword.value;

  // Production Cognito HTTP flow
  try {
    const data = await cognitoRequest('InitiateAuth', {
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: cognitoConfig.clientId,
      AuthParameters: {
        USERNAME: email,
        PASSWORD: password
      }
    }, 'Cognito authentication failed');

    if (!data.AuthenticationResult) {
      if (data.ChallengeName === 'NEW_PASSWORD_REQUIRED') {
        // Transition form to password reset state
        authSession = data.Session;
        challengeEmail = email;
        authPassword.value = '';
        setAuthFormMode('newPassword');
        return;
      }
      throw new Error('Authentication challenge required but not supported.');
    }

    handleLoginSuccess(data.AuthenticationResult.IdToken);
  } catch (err) {
    console.error("Cognito login error:", err);
    showAuthError(err.message || 'Login failed. Please check credentials.');
  }
});

authForgotLink.addEventListener('click', () => {
  clearAuthMessages();
  authPassword.value = '';
  setAuthFormMode('forgotRequest');
  authEmail.focus();
});

authBackLink.addEventListener('click', () => {
  resetAuthForm();
  authEmail.focus();
});

authResendCodeLink.addEventListener('click', async () => {
  if (!resetEmail) return;
  clearAuthMessages();
  authResendCodeLink.disabled = true;

  try {
    const destination = await requestPasswordReset(resetEmail);
    showAuthNotice(destination
      ? `New code sent to ${destination}.`
      : 'If that account exists, a new code is on its way.');
  } catch (err) {
    console.error("Password reset resend error:", err);
    showAuthError(resetErrorMessage(err, 'request'));
  } finally {
    authResendCodeLink.disabled = false;
  }
});

btnLogout.addEventListener('click', handleLogout);

function handleLoginSuccess(token) {
  idToken = token;
  localStorage.setItem('caucsim_id_token', token);
  resetAuthForm();
  authEmail.value = '';
  validateSession();
}

function showAuthError(msg) {
  authError.textContent = msg;
  authError.style.display = 'block';
  btnLoginSubmit.disabled = false;
  btnLoginSubmit.textContent = AUTH_SUBMIT_LABELS[authFormMode] || AUTH_SUBMIT_LABELS.signin;
}

// --- CFD Simulation Runner Client Logic ---
let cfdPollInterval = null;
let activeJobId = localStorage.getItem('caucsim_active_job_id') || null;
let isConsoleCollapsed = false;
let activeFlowImageUrl = null;

function showCfdMonitor(show) {
  // 'flex', not 'block': the monitor is a flex column and its console child
  // relies on flex: 1 to fill the remaining height.
  const el = document.getElementById('cfd-monitor');
  if (el) el.style.display = show ? 'flex' : 'none';

  // Placeholder fills the panel whenever no run is being monitored, so the
  // status panel is never blank.
  const emptyEl = document.getElementById('cfd-monitor-empty');
  if (emptyEl) emptyEl.style.display = show ? 'none' : 'flex';
}

function showCfdResults(show) {
  const el = document.getElementById('cfd-results');
  if (el) el.style.display = show ? 'block' : 'none';
}

async function startCfdSimulation() {
  if (!activeFileKey) {
    alert("Please load a geometry model first.");
    return;
  }
  
  const btnRunCfd = document.getElementById('btn-run-cfd');
  if (!btnRunCfd) return;
  btnRunCfd.disabled = true;
  btnRunCfd.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="margin-right: 8px; display: inline-block; vertical-align: middle; animation: spin 1s linear infinite;">
      <style>@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }</style>
      <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.49 8.49l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.49-8.49l2.83-2.83"/>
    </svg>
    Launching Droplet...
  `;
  
  // Provide an immediate visual update in the Simulation Logs & Progress section
  showCfdMonitor(true);
  showCfdResults(false);

  const statusBadge = document.getElementById('cfd-status-badge');
  const progressFill = document.getElementById('cfd-progress-fill');
  if (statusBadge) {
    statusBadge.textContent = 'Preparing';
    statusBadge.style.background = 'rgba(0, 240, 255, 0.1)';
    statusBadge.style.borderColor = 'var(--accent-cyan)';
    statusBadge.style.color = 'var(--accent-cyan)';
  }
  if (progressFill) {
    progressFill.style.width = '5%';
    progressFill.style.background = 'linear-gradient(90deg, var(--accent-cyan), var(--accent-purple))';
  }

  const consoleEl = document.getElementById('cfd-console');
  if (consoleEl) {
    consoleEl.textContent = 'Preparing simulation environment and requesting compute resources...\n';
  }

  const engineStatus = document.getElementById('engine-status');
  const engineStatusVal = document.getElementById('engine-status-val');
  if (engineStatus && engineStatusVal) {
    engineStatus.className = 'status-indicator online';
    engineStatusVal.textContent = 'Preparing';
  }

  // Instantly switch view to Stage 3 progress panel
  switchStage(3);

  try {
    const response = await fetch('/api/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${idToken || ''}`
      },
      body: JSON.stringify({
        fileKey: activeFileKey,
        frontalArea: currentFrontalArea,
        raceSpeedMph: raceSpeedMph
      })
    });
    
    if (response.status === 401) {
      handleLogout();
      return;
    }
    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error || 'Failed to start CFD simulation');
    }
    
    const job = await response.json();
    activeJobId = job.jobId;
    localStorage.setItem('caucsim_active_job_id', activeJobId);
    
    // Reset and show console/monitor with updated status
    if (consoleEl) {
      consoleEl.textContent = 'Launching droplet and configuring OpenFOAM environment...\n';
    }
    showCfdMonitor(true);
    showCfdResults(false);
    updateCfdMonitorState(job);
    
    // Start polling
    startCfdPolling();
    
    // Ensure we stay on Stage 3 with the actual job state
    switchStage(3);
    
  } catch (err) {
    console.error(err);
    alert(`CFD Launch Error: ${err.message}`);

    // Reset status indicators and append error details to console
    if (statusBadge) {
      statusBadge.textContent = 'Failed';
      statusBadge.style.background = 'rgba(255, 61, 0, 0.1)';
      statusBadge.style.borderColor = '#ff3d00';
      statusBadge.style.color = '#ff3d00';
    }
    if (progressFill) {
      progressFill.style.width = '0%';
    }
    if (consoleEl) {
      consoleEl.textContent += `\n[ERROR] CFD Simulation failed to start: ${err.message}\n`;
    }
    if (engineStatus && engineStatusVal) {
      engineStatus.className = 'status-indicator standby';
      engineStatusVal.textContent = 'Standby';
    }

    btnRunCfd.disabled = false;
    btnRunCfd.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="margin-right: 8px;">
        <path d="M5 3l14 9-14 9V3z"/>
      </svg>
      Run CFD Simulation
    `;
  }
}

function startCfdPolling() {
  if (cfdPollInterval) clearInterval(cfdPollInterval);
  pollCfdStatus();
  cfdPollInterval = setInterval(pollCfdStatus, 2000);
}

async function pollCfdStatus() {
  if (!activeJobId) {
    stopCfdPolling();
    return;
  }
  
  try {
    const response = await fetch(`/api/jobs/${activeJobId}`, {
      headers: {
        'Authorization': `Bearer ${idToken || ''}`
      }
    });
    
    if (!response.ok) {
      if (response.status === 401) {
        stopCfdPolling();
        handleLogout();
        return;
      }
      if (response.status === 404) {
        stopCfdPolling();
        clearCfdRun();
        return;
      }
      throw new Error('Failed to fetch job status');
    }
    
    const job = await response.json();
    updateCfdMonitorState(job);
    await fetchCfdLogs();
    
    if (job.status === 'completed') {
      stopCfdPolling();
      displayCfdResults(job);
      unlockStage(4);
      switchStage(4);
    } else if (job.status === 'failed') {
      stopCfdPolling();
      displayFailedCfdState(job);
      switchStage(3);
    }
  } catch (err) {
    console.error("Error polling CFD status:", err);
  }
}

function stopCfdPolling() {
  if (cfdPollInterval) {
    clearInterval(cfdPollInterval);
    cfdPollInterval = null;
  }
}

// Helper to scroll the CFD console robustly to the bottom
function scrollConsoleToBottom(consoleEl) {
  if (!consoleEl) return;
  consoleEl.scrollTop = consoleEl.scrollHeight;
  requestAnimationFrame(() => {
    consoleEl.scrollTop = consoleEl.scrollHeight;
  });
  setTimeout(() => {
    consoleEl.scrollTop = consoleEl.scrollHeight;
  }, 50);
}

async function fetchCfdLogs() {
  if (!activeJobId) return;
  try {
    const res = await fetch(`/api/jobs/${activeJobId}/log`, {
      headers: {
        'Authorization': `Bearer ${idToken || ''}`
      }
    });
    if (res.status === 401) {
      stopCfdPolling();
      handleLogout();
      return;
    }
    if (res.ok) {
      const logText = await res.text();
      const consoleEl = document.getElementById('cfd-console');
      if (consoleEl) {
        consoleEl.textContent = logText;
        scrollConsoleToBottom(consoleEl);
      }
    }
  } catch (e) {
    console.error("Error fetching logs:", e);
  }
}

// --- Stage 4 Execution Log Viewer ---
// Stage 3's live console scrolls away once a run completes and the user moves to
// Stage 4, so this re-fetches the finished log into a full-height overlay.
function closeLogModal() {
  const modal = document.getElementById('log-modal');
  if (modal) modal.style.display = 'none';
}

async function openLogModal() {
  const modal = document.getElementById('log-modal');
  const consoleEl = document.getElementById('log-modal-console');
  if (!modal || !consoleEl) return;

  modal.style.display = 'flex';

  if (!activeJobId) {
    consoleEl.textContent = 'No simulation run is currently loaded.';
    return;
  }

  consoleEl.textContent = 'Fetching execution log...';

  try {
    const res = await fetch(`/api/jobs/${activeJobId}/log`, {
      headers: {
        'Authorization': `Bearer ${idToken || ''}`
      }
    });

    if (res.status === 401) {
      closeLogModal();
      handleLogout();
      return;
    }
    if (!res.ok) {
      consoleEl.textContent = `Could not retrieve the execution log (status ${res.status}).`;
      return;
    }

    const logText = await res.text();
    consoleEl.textContent = logText.trim() ? logText : 'The execution log is empty for this run.';
    consoleEl.scrollTop = 0; // Start at the top: this is a completed log to read, not a live tail
  } catch (err) {
    console.error("Error fetching execution log:", err);
    consoleEl.textContent = 'Failed to fetch the execution log. Check your connection and try again.';
  }
}

function updateEngineStatus(job) {
  const engineStatus = document.getElementById('engine-status');
  const engineStatusVal = document.getElementById('engine-status-val');
  if (!engineStatus || !engineStatusVal) return;
  
  if (!job || job.status === 'completed' || job.status === 'failed') {
    engineStatus.className = 'status-indicator standby';
    engineStatusVal.textContent = 'Standby';
  } else if (job.status === 'queued') {
    engineStatus.className = 'status-indicator online';
    engineStatusVal.textContent = 'Queued';
  } else if (job.status === 'running') {
    engineStatus.className = 'status-indicator online';
    
    let stageText = 'Running';
    if (job.stage === 'initializing') stageText = 'Initializing';
    else if (job.stage === 'mesh_generation') stageText = 'Meshing';
    else if (job.stage === 'solving') stageText = 'Solving';
    else if (job.stage === 'processing_results') stageText = 'Processing';
    else if (job.stage === 'generating_visualisation') stageText = 'Rendering 3D';

    engineStatusVal.textContent = stageText;
  }
}

function updateCfdMonitorState(job) {
  const statusBadge = document.getElementById('cfd-status-badge');
  const progressFill = document.getElementById('cfd-progress-fill');
  
  if (!statusBadge || !progressFill) return;
  
  let stageName = 'Initializing';
  let percent = 0;
  
  switch(job.stage) {
    case 'initializing':
      stageName = 'Initializing Droplet';
      percent = 10;
      break;
    case 'mesh_generation':
      stageName = 'Generating Mesh';
      percent = 40;
      break;
    case 'solving':
      stageName = 'Solving OpenFOAM';
      percent = 75;
      break;
    case 'processing_results':
      stageName = 'Packaging Results';
      percent = 90;
      break;
    case 'generating_visualisation':
      stageName = 'Rendering 3D Visualisation';
      percent = 95;
      break;
    case 'completed':
      stageName = 'Completed';
      percent = 100;
      break;
    default:
      stageName = job.status || 'Running';
      percent = job.status === 'failed' ? 100 : 0;
  }
  
  statusBadge.textContent = stageName;
  progressFill.style.width = `${percent}%`;
  
  if (job.status === 'failed') {
    statusBadge.textContent = 'Failed';
    statusBadge.style.background = 'rgba(255, 61, 0, 0.1)';
    statusBadge.style.borderColor = '#ff3d00';
    statusBadge.style.color = '#ff3d00';
    progressFill.style.background = '#ff3d00';
  } else if (job.status === 'completed') {
    statusBadge.style.background = 'rgba(51, 255, 51, 0.1)';
    statusBadge.style.borderColor = '#33ff33';
    statusBadge.style.color = '#33ff33';
    progressFill.style.background = '#33ff33';
  } else {
    statusBadge.style.background = 'rgba(0, 240, 255, 0.1)';
    statusBadge.style.borderColor = 'var(--accent-cyan)';
    statusBadge.style.color = 'var(--accent-cyan)';
    progressFill.style.background = 'linear-gradient(90deg, var(--accent-cyan), var(--accent-purple))';
  }
  
  updateEngineStatus(job);
}

async function fetchFlowVisualisation(jobId) {
  const imgEl = document.getElementById('flow-visualisation-img');
  const placeholderEl = document.getElementById('flow-visualisation-placeholder');
  const placeholderTextEl = document.getElementById('flow-visualisation-placeholder-text');
  const loadingEl = document.getElementById('flow-visualisation-loading');
  
  if (!imgEl || !placeholderEl || !loadingEl) return;
  
  // Revoke previous URL to prevent memory leaks
  if (activeFlowImageUrl) {
    URL.revokeObjectURL(activeFlowImageUrl);
    activeFlowImageUrl = null;
  }
  
  // Reset placeholder text
  if (placeholderTextEl) {
    placeholderTextEl.textContent = 'No visualisation image available';
  }
  
  // Clean up any existing handlers to prevent empty src triggering onerror
  imgEl.onload = null;
  imgEl.onerror = null;
  imgEl.src = '';
  
  imgEl.style.display = 'none';
  placeholderEl.style.display = 'none';
  loadingEl.style.display = 'flex';
  
  try {
    const res = await fetch(`/api/jobs/${jobId}/visualisation?json=true`, {
      headers: {
        'Authorization': `Bearer ${idToken || ''}`
      }
    });
    
    if (res.ok) {
      const data = await res.json();
      
      // Register handlers before setting src to ensure correct order
      imgEl.onload = () => {
        imgEl.style.display = 'block';
        loadingEl.style.display = 'none';
        placeholderEl.style.display = 'none';
      };
      
      imgEl.onerror = () => {
        imgEl.style.display = 'none';
        loadingEl.style.display = 'none';
        placeholderEl.style.display = 'flex';
        if (placeholderTextEl) {
          placeholderTextEl.textContent = 'Visualisation image was not generated or failed to load';
        }
      };
      
      imgEl.src = data.url;
    } else {
      loadingEl.style.display = 'none';
      placeholderEl.style.display = 'flex';
      if (placeholderTextEl) {
        placeholderTextEl.textContent = 'Visualisation image was not generated for this simulation run';
      }
    }
  } catch (err) {
    console.error("Failed to load flow visualisation:", err);
    loadingEl.style.display = 'none';
    placeholderEl.style.display = 'flex';
    if (placeholderTextEl) {
      placeholderTextEl.textContent = 'Failed to fetch flow visualisation';
    }
  }
}

// Keeps the viewport toolbar toggle button, the state flag, and the loaded
// streamline scene's visibility in sync from every call site.
function setStreamlinesVisible(visible) {
  streamlinesToggleActive = visible;
  const btn = document.getElementById('toggle-streamlines');
  if (btn) btn.classList.toggle('active', visible);
  if (activeStreamlineScene) {
    activeStreamlineScene.visible = visible;
  }
}

function clearStreamlineScene() {
  if (activeStreamlineScene) {
    scene.remove(activeStreamlineScene);
    activeStreamlineScene = null;
  }
  setStreamlinesVisible(false);
}

async function fetchStreamlinesModel(jobId) {
  clearStreamlineScene();
  try {
    const res = await fetch(`/api/jobs/${jobId}/streamlines-model?json=true`, {
      headers: {
        'Authorization': `Bearer ${idToken || ''}`
      }
    });

    if (!res.ok) return;

    const data = await res.json();
    const loader = new GLTFLoader();
    loader.load(data.url, (gltf) => {
      const streamlineScene = gltf.scene;
      // ParaView exports in meters; the app's world units are millimeters (matches loadSTL's m->mm scaling)
      streamlineScene.scale.set(1000, 1000, 1000);
      streamlineScene.position.set(0, 0, 0);
      activeStreamlineScene = streamlineScene;
      scene.add(streamlineScene);
      // Streamlines are only viewable here on the car model, so show them as
      // soon as the run's model arrives; the toolbar toggle can hide them.
      setStreamlinesVisible(true);
    }, undefined, (err) => {
      console.error('Error loading 3D flow visualisation scene:', err);
    });
  } catch (err) {
    console.error("Failed to fetch streamlines model:", err);
  }
}

function showResultsSummary(hasResults) {
  const emptyEl = document.getElementById('results-details-empty');
  const loadedEl = document.getElementById('results-details-loaded');
  if (emptyEl) emptyEl.style.display = hasResults ? 'none' : 'flex';
  if (loadedEl) loadedEl.style.display = hasResults ? 'block' : 'none';
}

function displayCfdResults(job) {
  showCfdMonitor(false);
  showCfdResults(true);
  showResultsSummary(true);

  if (job && job.jobId) {
    fetchFlowVisualisation(job.jobId);
    fetchStreamlinesModel(job.jobId);
  }
  
  // Reflect the speed the job actually ran at, which may differ from the
  // current input value if the run was resumed after a reload.
  const jobSpeedMph = job.raceSpeedMph || DEFAULT_RACE_SPEED_MPH;
  raceSpeedMph = jobSpeedMph;
  const raceSpeedInput = document.getElementById('race-speed-input');
  if (raceSpeedInput) raceSpeedInput.value = raceSpeedMph;
  updateRaceSpeedLabels();
  updateResultsSpeedLabels(jobSpeedMph);

  const m = job.metrics;
  if (!m) return;

  const density = 1.225; // kg/m³
  const speed = jobSpeedMph * MPH_TO_MS;

  const cdVal = m.cd !== undefined ? m.cd : 0;
  const clVal = m.cl !== undefined ? m.cl : 0;
  const cdaVal = m.cda !== undefined ? m.cda : (cdVal * (m.aref || 0.197));
  const claVal = m.cla !== undefined ? m.cla : (clVal * (m.aref || 0.197));
  
  const dragForce = m.dragForce !== undefined ? m.dragForce : (0.5 * density * speed * speed * cdaVal);
  const liftForce = m.liftForce !== undefined ? m.liftForce : (0.5 * density * speed * speed * claVal);
  const aeroPower = m.aeroPower !== undefined ? m.aeroPower : (dragForce * speed);
  
  document.getElementById('cfd-cd').textContent = cdVal.toFixed(3);
  document.getElementById('cfd-cda').textContent = cdaVal.toFixed(4) + ' m²';
  document.getElementById('cfd-cl').textContent = clVal.toFixed(3);
  document.getElementById('cfd-cla').textContent = claVal.toFixed(4) + ' m²';
  
  document.getElementById('cfd-drag-force').textContent = dragForce.toFixed(1) + ' N';
  document.getElementById('cfd-lift-force').textContent = liftForce.toFixed(1) + ' N';
  document.getElementById('cfd-power').textContent = aeroPower.toFixed(0) + ' W';
  
  const btnRunCfd = document.getElementById('btn-run-cfd');
  if (btnRunCfd) {
    btnRunCfd.disabled = false;
    btnRunCfd.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="margin-right: 8px;">
        <path d="M5 3l14 9-14 9V3z"/>
      </svg>
      Run CFD Simulation
    `;
  }
}

function displayFailedCfdState(job) {
  showCfdMonitor(true);
  showCfdResults(false);
  const consoleEl = document.getElementById('cfd-console');
  if (consoleEl) {
    consoleEl.textContent += `\n\n[ERROR] CFD Simulation failed: ${job.error || 'Unknown Error'}\n`;
    scrollConsoleToBottom(consoleEl);
  }
  
  const btnRunCfd = document.getElementById('btn-run-cfd');
  if (btnRunCfd) {
    btnRunCfd.disabled = false;
    btnRunCfd.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="margin-right: 8px;">
        <path d="M5 3l14 9-14 9V3z"/>
      </svg>
      Run CFD Simulation
    `;
  }
}

function clearCfdRun() {
  stopCfdPolling();
  activeJobId = null;
  localStorage.removeItem('caucsim_active_job_id');
  showCfdMonitor(false);
  showCfdResults(false);
  showResultsSummary(false);
  updateEngineStatus(null);
  
  // Clear flow visualization state
  const imgEl = document.getElementById('flow-visualisation-img');
  const placeholderEl = document.getElementById('flow-visualisation-placeholder');
  const loadingEl = document.getElementById('flow-visualisation-loading');
  if (imgEl && placeholderEl && loadingEl) {
    imgEl.src = '';
    imgEl.style.display = 'none';
    loadingEl.style.display = 'none';
    placeholderEl.style.display = 'flex';
  }
  if (activeFlowImageUrl) {
    URL.revokeObjectURL(activeFlowImageUrl);
    activeFlowImageUrl = null;
  }

  // Clear 3D streamlines from the viewport
  clearStreamlineScene();

  // The log belongs to the run being cleared, so don't leave it on screen
  closeLogModal();

  const consoleEl = document.getElementById('cfd-console');
  if (consoleEl) {
    consoleEl.textContent = '';
  }
  const statusBadge = document.getElementById('cfd-status-badge');
  if (statusBadge) {
    statusBadge.textContent = 'Ready to Run';
    statusBadge.style.background = 'rgba(255, 170, 0, 0.1)';
    statusBadge.style.borderColor = '#ffaa00';
    statusBadge.style.color = '#ffaa00';
  }
  const progressFill = document.getElementById('cfd-progress-fill');
  if (progressFill) {
    progressFill.style.width = '0%';
  }
  
  // Lock Stage 4 and return to Stage 2 or 1
  lockStage(4);
  if (activeFileKey) {
    switchStage(2);
  } else {
    switchStage(1);
  }
  
  // Clear simulation results UI
  document.getElementById('cfd-cd').textContent = '-';
  document.getElementById('cfd-cda').textContent = '-';
  document.getElementById('cfd-cl').textContent = '-';
  document.getElementById('cfd-cla').textContent = '-';
  document.getElementById('cfd-drag-force').textContent = '-';
  document.getElementById('cfd-lift-force').textContent = '-';
  document.getElementById('cfd-power').textContent = '-';
  
  const btnRunCfd = document.getElementById('btn-run-cfd');
  if (btnRunCfd) {
    btnRunCfd.disabled = !activeFileKey;
    btnRunCfd.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="margin-right: 8px;">
        <path d="M5 3l14 9-14 9V3z"/>
      </svg>
        Run CFD Simulation
    `;
  }

  const btnAnalyseGeometry = document.getElementById('btn-analyse-geometry');
  if (btnAnalyseGeometry) {
    btnAnalyseGeometry.disabled = !activeFileKey;
  }
}

function initCfdRunner() {
  const btnRunCfd = document.getElementById('btn-run-cfd');
  const btnToggleConsole = document.getElementById('btn-toggle-console');
  const btnClearCfd = document.getElementById('btn-clear-cfd');
  const downloadLnk = document.getElementById('lnk-download-results');
  const viewLogLnk = document.getElementById('lnk-view-log');

  if (viewLogLnk) {
    viewLogLnk.addEventListener('click', (e) => {
      e.preventDefault();
      openLogModal();
    });
  }

  const btnCloseLog = document.getElementById('btn-close-log');
  if (btnCloseLog) {
    btnCloseLog.addEventListener('click', closeLogModal);
  }

  // Dismiss on backdrop click and Escape, matching typical overlay behaviour
  const logModal = document.getElementById('log-modal');
  if (logModal) {
    logModal.addEventListener('click', (e) => {
      if (e.target === logModal) closeLogModal();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeLogModal();
  });
  
  if (btnRunCfd) {
    btnRunCfd.addEventListener('click', startCfdSimulation);
    btnRunCfd.disabled = !activeFileKey;
  }
  
  if (btnToggleConsole) {
    btnToggleConsole.addEventListener('click', () => {
      const consoleEl = document.getElementById('cfd-console');
      isConsoleCollapsed = !isConsoleCollapsed;
      if (isConsoleCollapsed) {
        consoleEl.style.display = 'none';
        btnToggleConsole.textContent = 'Expand';
      } else {
        consoleEl.style.display = 'block';
        btnToggleConsole.textContent = 'Collapse';
        scrollConsoleToBottom(consoleEl);
      }
    });
  }
  
  if (btnClearCfd) {
    btnClearCfd.addEventListener('click', clearCfdRun);
  }
  
  if (downloadLnk) {
    downloadLnk.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!activeJobId) return;
      
      try {
        downloadLnk.style.pointerEvents = 'none';
        downloadLnk.style.opacity = '0.5';
        
        const res = await fetch(`/api/jobs/${activeJobId}/download?json=true`, {
          headers: {
            'Authorization': `Bearer ${idToken || ''}`
          }
        });
        
        if (res.ok) {
          const data = await res.json();
          window.open(data.url, '_blank');
        } else {
          alert("Failed to retrieve download URL.");
        }
      } catch (err) {
        console.error(err);
        alert("Error downloading results.");
      } finally {
        downloadLnk.style.pointerEvents = 'auto';
        downloadLnk.style.opacity = '1';
      }
    });
  }
  
  if (activeJobId) {
    unlockStage(2);
    unlockStage(3);
    showCfdMonitor(true);
    startCfdPolling();
    
    // Fetch the job status first to determine active stage
    fetch(`/api/jobs/${activeJobId}`, {
      headers: {
        'Authorization': `Bearer ${idToken || ''}`
      }
    }).then(res => res.json()).then(job => {
      if (job.status === 'completed') {
        unlockStage(4);
        displayCfdResults(job);
        switchStage(4);
      } else if (job.status === 'failed') {
        displayFailedCfdState(job);
        switchStage(3);
      } else {
        switchStage(3);
      }
    }).catch(err => {
      console.error(err);
      switchStage(3);
    });
  } else if (activeFileKey) {
    unlockStage(2);
    const btnAnalyseGeometry = document.getElementById('btn-analyse-geometry');
    if (btnAnalyseGeometry) {
      btnAnalyseGeometry.disabled = false;
    }
    switchStage(1);
  } else {
    switchStage(1);
  }
}

// Enable CFD button when stats are computed
const originalComputeStats = computeStats;
computeStats = function(geometry, size) {
  originalComputeStats(geometry, size);
  const btnRunCfd = document.getElementById('btn-run-cfd');
  if (btnRunCfd && !activeJobId) {
    btnRunCfd.disabled = false;
  }
};

// --- App Bootstrap ---
function bootstrapApp() {
  initThree();
  bindEvents();
  checkStorageStatus();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootstrapApp);
} else {
  bootstrapApp();
}
