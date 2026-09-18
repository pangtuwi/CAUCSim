import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HELP_PAGES } from './help-content.js';

// --- State Management ---
let scene, camera, renderer, controls;
let activeMesh = null;
let activePoints = null;
let activeWireframe = null;
let activeGeometry = null; // Store geometry for volume recalculations
let gridHelper, axesHelper;
// Three independently-toggleable streamline seed sets (centreline / current /
// outboard), each fetched as its own small GLTF -- see fetchStreamlinesModel.
const STREAMLINE_SET_NAMES = ['centreline', 'current', 'outboard'];
let streamlineSets = {
  centreline: { scene: null, visible: false, available: false },
  current: { scene: null, visible: false, available: false },
  outboard: { scene: null, visible: false, available: false }
};
// Bumped on every clear/reload so a slow in-flight streamline fetch that
// resolves after the user has already moved on can't add itself to the scene.
let streamlineLoadToken = 0;
let activePressureScene = null;
let pressureToggleActive = false;
let pressureAvailable = false;
// Bumped on every clear/reload, same purpose as streamlineLoadToken but
// tracked separately since the two fetches are independent.
let pressureLoadToken = 0;
// Remembers which Shaded/Wire/Points mode was active before the pressure
// overlay replaced it, so turning pressure off can restore it.
let currentRenderMode = 'shaded'; // 'shaded' | 'wireframe' | 'points'
let activeFilename = null;
let activeUrl = null;
let activeFileKey = null;
let currentFrontalArea = 0;
// Wheelbase (m) normalises Cm, and the moment centre is the point Cm is
// taken about. Both are pre-filled from the model and sent with the job.
let currentWheelbase = 0;
let currentMomentCentreX = 0;
let activeStage = 1;
let unlockedStages = new Set([1]);

const MPH_TO_MS = 0.44704;
const DEFAULT_RACE_SPEED_MPH = 30;
let raceSpeedMph = DEFAULT_RACE_SPEED_MPH;

function raceSpeedMs(mph) {
  return mph * MPH_TO_MS;
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

// Run History Elements
const historyModal = document.getElementById('history-modal');
const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');

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
const btnHistory = document.getElementById('btn-history');
const btnHelp = document.getElementById('btn-help');
const wheelbaseInput = document.getElementById('wheelbase-input');
const fastCheckInput = document.getElementById('fast-check-input');

// Stats Elements
const statTriangles = document.getElementById('stat-triangles');
const statVertices = document.getElementById('stat-vertices');
const statVolume = document.getElementById('stat-volume');
const statSurfaceArea = document.getElementById('stat-surface-area');
const statFrontalArea = document.getElementById('stat-frontal-area');
const frontalAreaItem = document.getElementById('frontal-area-item');
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

  // 1. Update the stage tab bar (drives navigation between stages)
  for (let i = 1; i <= 4; i++) {
    const tabEl = document.getElementById(`tab-stage-${i}`);
    if (tabEl) {
      tabEl.classList.toggle('active', i === activeStage);
      tabEl.classList.toggle('disabled', !unlockedStages.has(i));
    }
  }

  // 2. Update the Input panel's stage cards (which one is visible)
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

  // 3. Update right-side stage data panels visibility
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
  
  // 4. Stage 4's charts live in the right-hand summary panel, which was
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
  const tabEl = document.getElementById(`tab-stage-${stageNum}`);
  if (tabEl) {
    tabEl.classList.remove('disabled');
  }
}
window.unlockStage = unlockStage;

function lockStage(stageNum) {
  unlockedStages.delete(stageNum);
  const cardEl = document.getElementById(`card-stage-${stageNum}`);
  if (cardEl) {
    cardEl.classList.add('disabled');
  }
  const tabEl = document.getElementById(`tab-stage-${stageNum}`);
  if (tabEl) {
    tabEl.classList.add('disabled');
  }
}
window.lockStage = lockStage;

// --- SVG Performance Charts Rendering ---
// Reads the current CdA / ClA from the summary cards.
function readChartCoefficients() {
  return {
    cdaVal: parseFloat(document.getElementById('cfd-cda').textContent) || 0.048,
    claVal: parseFloat(document.getElementById('cfd-cla').textContent) || -0.019
  };
}

// Builds the two chart SVGs at an arbitrary pixel size so the same drawing
// code serves both the Results panel and the enlarged chart modal. `scale`
// grows the paddings, legend and markers for big canvases; label font sizes
// are handled in CSS (.chart-zoom-body .chart-label-text).
function buildPerformanceChartSvgs(w, h, cdaVal, claVal, scale = 1) {
  const padding = { left: 45 * scale, right: 15 * scale, top: 15 * scale, bottom: 30 * scale };
  const graphW = w - padding.left - padding.right;
  const graphH = h - padding.top - padding.bottom;
  
  const density = 1.225; // kg/m³
  const vRace = raceSpeedMs(raceSpeedMph);
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
  const markerR = 4.5 * scale;
  
  const forcesSvg = `
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
      <circle cx="${xRace}" cy="${raceDragCoord.split(',')[1]}" r="${markerR}" class="chart-marker chart-marker-drag" />
      <circle cx="${xRace}" cy="${raceLiftCoord.split(',')[1]}" r="${markerR}" class="chart-marker chart-marker-lift" />
      
      <!-- Legend -->
      <g transform="translate(${padding.left + 15 * scale}, ${padding.top + 10 * scale})">
        <rect x="0" y="0" width="${8 * scale}" height="${8 * scale}" fill="var(--accent-cyan)" rx="2"/>
        <text x="${12 * scale}" y="${8 * scale}" class="chart-label-text" style="fill:var(--text-primary);">Drag Force (N)</text>
        
        <rect x="${110 * scale}" y="0" width="${8 * scale}" height="${8 * scale}" fill="var(--accent-purple)" rx="2"/>
        <text x="${122 * scale}" y="${8 * scale}" class="chart-label-text" style="fill:var(--text-primary);">Lift Force (N)</text>
      </g>
      
      <!-- X Axis Label -->
      <text x="${padding.left + graphW / 2}" y="${h - 5 * scale}" class="chart-label-text chart-axis-title" text-anchor="middle">Velocity (m/s)</text>
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
  
  const powerSvg = `
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
      <circle cx="${xRace}" cy="${racePowerCoord.split(',')[1]}" r="${markerR}" class="chart-marker chart-marker-power" />
      
      <!-- Legend -->
      <g transform="translate(${padding.left + 15 * scale}, ${padding.top + 10 * scale})">
        <rect x="0" y="0" width="${8 * scale}" height="${8 * scale}" fill="#ff9d00" rx="2"/>
        <text x="${12 * scale}" y="${8 * scale}" class="chart-label-text" style="fill:var(--text-primary);">Aero Power Required (W)</text>
      </g>
      
      <!-- X Axis Label -->
      <text x="${padding.left + graphW / 2}" y="${h - 5 * scale}" class="chart-label-text chart-axis-title" text-anchor="middle">Velocity (m/s)</text>
    </svg>
  `;

  return { forces: forcesSvg, power: powerSvg };
}

function renderPerformanceCharts() {
  const forcesWrapper = document.getElementById('forces-chart-svg');
  const powerWrapper = document.getElementById('power-chart-svg');
  if (!forcesWrapper || !powerWrapper) return;

  const { cdaVal, claVal } = readChartCoefficients();
  const w = forcesWrapper.clientWidth || 500;
  const h = forcesWrapper.clientHeight || 200;
  const svgs = buildPerformanceChartSvgs(w, h, cdaVal, claVal);
  forcesWrapper.innerHTML = svgs.forces;
  powerWrapper.innerHTML = svgs.power;
}
window.renderPerformanceCharts = renderPerformanceCharts;

// Window resize handler for performance charts
window.addEventListener('resize', () => {
  if (activeStage === 4) {
    renderPerformanceCharts();
  }
  if (isChartModalOpen()) renderChartModal();
});

// Helper function to reset active model states
// The wheelbase field is pre-filled from the bounding box but is the user's
// to correct, so read it at submit time. A blank or invalid entry falls back to
// the model-derived value rather than blocking the run.
function readWheelbase() {
  if (!wheelbaseInput) return currentWheelbase;
  const parsed = parseFloat(wheelbaseInput.value);
  if (!isFinite(parsed) || parsed <= 0) return currentWheelbase;
  return parsed;
}

function resetActiveGeometry() {
  clearActiveGeometry();
  // The active file is going away, so any run/results/streamlines tied to it
  // must go too — otherwise they linger over whatever is loaded next.
  clearCfdRun();

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
  currentWheelbase = 0;
  currentMomentCentreX = 0;
  if (wheelbaseInput) wheelbaseInput.value = '';
  if (fastCheckInput) fastCheckInput.checked = false;
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
// --- Resizable Input/Results panels ---
const PANEL_WIDTH_STORAGE_KEY = 'caucsim_panel_widths';
const PANEL_WIDTH_MIN = 260;
const PANEL_WIDTH_MAX = 640;
const PANEL_WIDTH_DEFAULT = 330;

function clampPanelWidth(value, fallback) {
  return (typeof value === 'number' && isFinite(value))
    ? Math.min(PANEL_WIDTH_MAX, Math.max(PANEL_WIDTH_MIN, value))
    : fallback;
}

function loadPanelWidths() {
  try {
    const raw = JSON.parse(localStorage.getItem(PANEL_WIDTH_STORAGE_KEY) || '{}');
    return {
      input: clampPanelWidth(raw.input, PANEL_WIDTH_DEFAULT),
      results: clampPanelWidth(raw.results, PANEL_WIDTH_DEFAULT)
    };
  } catch {
    return { input: PANEL_WIDTH_DEFAULT, results: PANEL_WIDTH_DEFAULT };
  }
}

function savePanelWidths(widths) {
  localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, JSON.stringify(widths));
}

function applyPanelWidths(widths) {
  document.documentElement.style.setProperty('--input-panel-width', widths.input + 'px');
  document.documentElement.style.setProperty('--results-panel-width', widths.results + 'px');
}

// Wires up pointer-drag resizing for a single gutter. `sign` accounts for
// which edge of the panel the gutter sits on: dragging the Input/Display
// gutter right (+dx) widens the Input panel (its right edge moves), while
// dragging the Display/Results gutter right (+dx) narrows the Results panel
// (its *left* edge moves, so the width shrinks) -- hence the opposite sign.
function setupResizeGutter(gutterId, widthKey, sign, widths) {
  const gutterEl = document.getElementById(gutterId);
  if (!gutterEl) return;
  let startX = 0;
  let startWidth = 0;

  gutterEl.addEventListener('pointerdown', (e) => {
    gutterEl.setPointerCapture(e.pointerId);
    gutterEl.classList.add('dragging');
    startX = e.clientX;
    startWidth = widths[widthKey];
  });
  gutterEl.addEventListener('pointermove', (e) => {
    if (!gutterEl.hasPointerCapture(e.pointerId)) return;
    const delta = (e.clientX - startX) * sign;
    widths[widthKey] = clampPanelWidth(startWidth + delta, startWidth);
    applyPanelWidths(widths);
  });
  gutterEl.addEventListener('pointerup', (e) => {
    if (gutterEl.hasPointerCapture(e.pointerId)) {
      gutterEl.releasePointerCapture(e.pointerId);
    }
    gutterEl.classList.remove('dragging');
    savePanelWidths(widths);
  });
}

// Applies persisted widths and wires up the drag handles. Must run before
// initThree(), since initThree() reads the viewport container's clientWidth/
// Height synchronously to size the camera/renderer for the first frame.
function initResizablePanels() {
  const widths = loadPanelWidths();
  applyPanelWidths(widths);
  setupResizeGutter('gutter-input-display', 'input', 1, widths);
  setupResizeGutter('gutter-display-results', 'results', -1, widths);
}

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
  // A window resize event doesn't fire when only the grid columns change
  // (e.g. dragging a resize-gutter, or the workspace scrolling horizontally
  // at a narrow width) -- watch the container's own box directly too.
  new ResizeObserver(onWindowResize).observe(viewportContainer);

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
    // Swapping to a different file discards any CFD run tied to the current
    // one. Historical-run navigation (viewHistoricalJob/returnToActiveRun)
    // also swaps files through here but is intentionally silent — it isn't
    // discarding anything, just changing which run is being reviewed.
    if (!viewingHistoryReadOnly && activeJobId) {
      const proceed = confirm('Loading a different CAD model will discard the current CFD run and its results. Continue?');
      if (!proceed) return;
    }
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

  // Stage 2 / Check Geometry aren't meaningful until this model has actually
  // finished loading -- re-lock (a previously-loaded file may have unlocked
  // it already) and only unlock again once loading succeeds, below.
  lockStage(2);
  const btnAnalyseGeometry = document.getElementById('btn-analyse-geometry');
  if (btnAnalyseGeometry) {
    btnAnalyseGeometry.disabled = true;
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

      // The model has actually finished loading now -- Check Geometry is
      // meaningful and Stage 2 can be reached.
      unlockStage(2);
      if (btnAnalyseGeometry) {
        btnAnalyseGeometry.disabled = false;
      }
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
  // While the pressure overlay is showing, it replaces whichever of these
  // three representations was active -- leave it alone here, and let
  // setPressureVisible(false) call this again to restore it.
  if (pressureToggleActive) return;

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
  if (frontalAreaItem) {
    const isFrontalAreaOk = frontalAreaM2 >= 0.1 && frontalAreaM2 <= 1.0;
    frontalAreaItem.className = isFrontalAreaOk ? 'reg-item pass' : 'reg-item fail';
  }

  // Reference length and moment centre for the force coefficients. World units
  // are mm (loadSTL normalises to mm), and the OpenFOAM case is in metres.
  // Bounding-box length overestimates the true wheelbase by the nose and tail
  // overhangs, so it is only a starting point the user can correct.
  currentWheelbase = l / 1000;
  currentMomentCentreX = (geometry.boundingBox.min.x + l / 2) / 1000;
  if (wheelbaseInput) wheelbaseInput.value = currentWheelbase.toFixed(2);

  // Watertight status
  const isWatertight = volumeCm3 > 0.01; // basic validation
  regWatertightVal.textContent = isWatertight ? 'Pass' : 'Warning (Open Mesh)';
  if (isWatertight) {
    regWatertight.className = 'reg-item pass';
  } else {
    regWatertight.className = 'reg-item fail';
  }

  // F24 Regulations Checks
  // Max Length: 2800 mm
  regLenVal.textContent = `${l.toFixed(1)} mm`;
  if (l <= 2800) {
    regLen.className = 'reg-item pass';
  } else {
    regLen.className = 'reg-item fail';
  }

  // Max Width: 1200 mm
  regWidVal.textContent = `${w.toFixed(1)} mm`;
  if (w <= 1200) {
    regWid.className = 'reg-item pass';
  } else {
    regWid.className = 'reg-item fail';
  }

  // Max Height: 1200 mm
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
  if (l <= 2800 && w <= 1200 && h <= 1200 && isWatertight && isScaleOk && isXAligned && isYSymmetrical && isZAligned) {
    regSummary.textContent = 'PASSED F24 DIMENSIONAL LIMITS';
    regSummary.className = 'reg-summary-box pass';
  } else {
    let reasons = [];
    if (l > 2800) reasons.push('Length exceeds limit');
    if (w > 1200) reasons.push('Width exceeds limit');
    if (h > 1200) reasons.push('Height exceeds limit');
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
      const isActiveWithRun = activeFileKey === file.fileKey && !!activeJobId;
      const confirmMsg = isActiveWithRun
        ? `Delete ${file.originalName}? This will also discard its current CFD run and results.`
        : `Are you sure you want to delete ${file.originalName}?`;
      if (confirm(confirmMsg)) {
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
  if (msDisplay) msDisplay.textContent = raceSpeedMs(raceSpeedMph).toFixed(1);
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
// Run CFD Simulation requires geometry to already be loaded, no run already
// in flight, and a run name + purpose/notes -- re-evaluated whenever those
// two inputs change, and called instead of a bare `disabled = false` from
// every other place that used to just re-enable the button unconditionally
// (after a failed launch, a completed/failed run, or Clear Run) so none of
// them can leave it enabled with the fields still blank.
function updateRunCfdButtonState() {
  const btnRunCfd = document.getElementById('btn-run-cfd');
  if (!btnRunCfd) return;
  const runNameInput = document.getElementById('run-name-input');
  const runPurposeInput = document.getElementById('run-purpose-input');
  const hasRunName = !!(runNameInput && runNameInput.value.trim());
  const hasPurpose = !!(runPurposeInput && runPurposeInput.value.trim());
  btnRunCfd.disabled = !activeFileKey || !!activeJobId || !hasRunName || !hasPurpose;
}

// While a run is in flight the button is disabled, so its label doubles as a
// second, at-a-glance copy of the live status (mirrors #cfd-status-badge)
// rather than a fixed "Launching Droplet..." caption that never changes.
function setRunCfdButtonSpinnerLabel(label) {
  const btnRunCfd = document.getElementById('btn-run-cfd');
  if (!btnRunCfd) return;
  btnRunCfd.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="margin-right: 8px; display: inline-block; vertical-align: middle; animation: spin 1s linear infinite;">
      <style>@keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }</style>
      <path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.49 8.49l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.49-8.49l2.83-2.83"/>
    </svg>
    ${label}
  `;
}

function bindEvents() {
  // Stage tab bar -- navigation now lives here instead of the old
  // clickable workflow-card headers.
  document.querySelectorAll('.stage-tab').forEach(tabEl => {
    tabEl.addEventListener('click', () => {
      switchStage(parseInt(tabEl.dataset.stage, 10));
    });
  });

  const runNameInput = document.getElementById('run-name-input');
  if (runNameInput) {
    runNameInput.addEventListener('input', updateRunCfdButtonState);
  }
  const runPurposeInput = document.getElementById('run-purpose-input');
  if (runPurposeInput) {
    runPurposeInput.addEventListener('input', updateRunCfdButtonState);
  }

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

  // Streamline sets are multi-select: each button toggles independently, so
  // any combination of centreline/current/outboard can be shown together.
  STREAMLINE_SET_NAMES.forEach(setName => {
    const btn = document.getElementById(`toggle-streamlines-${setName}`);
    if (!btn) return;
    btn.addEventListener('click', () => {
      setStreamlinesVisible(setName, !streamlineSets[setName].visible);
    });
  });

  const togglePressureBtn = document.getElementById('toggle-pressure');
  togglePressureBtn.addEventListener('click', () => {
    setPressureVisible(!pressureToggleActive);
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
    btnHistory.style.display = 'block';
    btnHelp.style.display = 'block';
    fetchLibrary();
  } else {
    authModal.style.display = 'flex';
    btnLogout.style.display = 'none';
    btnHistory.style.display = 'none';
    btnHelp.style.display = 'none';
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

  // Every overlay shares z-index 10000 and #help-modal is last in the DOM, so
  // a 401 while the tutorial is open would paint it over the login modal.
  closeHelpModal();

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

btnHistory.addEventListener('click', openHistoryModal);
btnHelp.addEventListener('click', openHelpModal);
document.getElementById('btn-close-history')?.addEventListener('click', () => {
  historyModal.style.display = 'none';
});
document.getElementById('btn-return-active-run')?.addEventListener('click', returnToActiveRun);

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
// Bumped on every fetch so a slow in-flight visualisation request that
// resolves after the user has moved to a different run can't overwrite it.
let flowVisLoadToken = 0;
// True while Stage 4 is showing a past run pulled up from Run History rather
// than the run actually tracked by activeJobId/localStorage — gates the
// localStorage writes below so browsing history can never clobber the
// pointer to whatever run is really active.
let viewingHistoryReadOnly = false;
let savedActiveJobIdBeforeHistory = null;
// The model actually loaded before Run History swapped in whatever geometry
// the viewed run used, so returnToActiveRun can put it back afterwards.
let savedActiveFileBeforeHistory = null;

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

async function openHistoryModal() {
  historyModal.style.display = 'flex';
  historyList.innerHTML = '';
  historyEmpty.style.display = 'none';
  try {
    const response = await fetch('/api/jobs', {
      headers: { 'Authorization': `Bearer ${idToken || ''}` }
    });
    if (response.status === 401) {
      handleLogout();
      return;
    }
    if (!response.ok) throw new Error('Failed to load run history');
    const jobs = await response.json();
    renderHistoryList(jobs);
  } catch (err) {
    console.error('Error loading run history:', err);
    historyEmpty.textContent = 'Failed to load run history.';
    historyEmpty.style.display = 'block';
  }
}

function renderHistoryList(jobs) {
  historyList.innerHTML = '';

  if (!jobs || jobs.length === 0) {
    historyEmpty.textContent = 'No past runs found.';
    historyEmpty.style.display = 'block';
    return;
  }

  historyEmpty.style.display = 'none';

  jobs.forEach(job => {
    const li = document.createElement('li');
    li.className = 'model-item';
    li.dataset.jobid = job.jobId;

    const dateStr = job.startedAt ? new Date(job.startedAt).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }) : 'Unknown date';

    const statusColors = {
      completed: '#00e08a',
      failed: '#ff4d4d',
      running: '#00f0ff',
      queued: '#ffaa00'
    };
    const statusColor = statusColors[job.status] || '#ffaa00';
    const cdText = job.metrics && job.metrics.cd !== undefined ? `Cd ${job.metrics.cd.toFixed(3)}` : '';

    li.innerHTML = `
      <div class="model-item-details">
        <span class="model-item-name" title="${job.runName || job.originalName || job.jobId}">${job.runName || job.originalName || job.jobId}</span>
        <div class="model-item-meta">
          <span style="color: ${statusColor};">${job.status || 'unknown'}</span>
          <span>•</span>
          <span>${dateStr}</span>
          ${cdText ? `<span>•</span><span>${cdText}</span>` : ''}
        </div>
      </div>
    `;

    li.addEventListener('click', () => viewHistoricalJob(job.jobId));
    historyList.appendChild(li);
  });
}

async function viewHistoricalJob(jobId) {
  const wasPolling = !!cfdPollInterval;
  if (wasPolling) savedActiveJobIdBeforeHistory = activeJobId;
  stopCfdPolling();

  try {
    const response = await fetch(`/api/jobs/${jobId}`, {
      headers: { 'Authorization': `Bearer ${idToken || ''}` }
    });
    if (response.status === 401) {
      handleLogout();
      return;
    }
    if (!response.ok) throw new Error('Failed to load run details');
    const job = await response.json();

    historyModal.style.display = 'none';

    // Only capture the pre-history model once, on the way in — switching
    // between two historical jobs must not overwrite it with the previous
    // historical job's model.
    if (!viewingHistoryReadOnly) {
      savedActiveFileBeforeHistory = activeFileKey
        ? { fileKey: activeFileKey, originalName: activeFilename, viewUrl: activeUrl }
        : null;
    }
    // Setting this before touching the model matters: loadSTL (via
    // fetchLibrary below) calls clearCfdRun when the fileKey changes, and
    // clearCfdRun only skips clobbering the real active-job pointer in
    // localStorage while this flag is already true.
    viewingHistoryReadOnly = true;

    // The run's own geometry, not whatever happens to be in the viewport —
    // otherwise the streamlines render over a mismatched (or absent) model.
    if (job.fileKey && job.fileKey !== activeFileKey) {
      await fetchLibrary(job.fileKey);
    }

    activeJobId = job.jobId;

    unlockStage(3);
    unlockStage(4);
    switchStage(4);
    updateCfdMonitorState(job);
    await fetchCfdLogs();

    if (job.status === 'completed') {
      displayCfdResults(job);
    } else if (job.status === 'failed') {
      displayFailedCfdState(job);
    } else {
      showCfdMonitor(true);
    }

    const banner = document.getElementById('history-readonly-banner');
    const bannerText = document.getElementById('history-readonly-banner-text');
    if (banner) {
      banner.style.display = wasPolling ? 'flex' : 'none';
      if (bannerText) bannerText.textContent = `Viewing past run: ${job.runName || job.originalName || job.jobId} (read-only)`;
    }
  } catch (err) {
    console.error('Error loading historical run:', err);
    alert('Failed to load that run.');
  }
}

async function returnToActiveRun() {
  // Put back whatever model was in the viewport before history swapped it —
  // do this first (and awaited: fetchLibrary's loadSTL fires asynchronously
  // once the file list arrives), since loadSTL/resetActiveGeometry both
  // route through clearCfdRun and would otherwise wipe the activeJobId
  // restored below if that landed after this function had already returned.
  if (savedActiveFileBeforeHistory) {
    if (savedActiveFileBeforeHistory.fileKey !== activeFileKey) {
      await fetchLibrary(savedActiveFileBeforeHistory.fileKey);
    }
  } else if (activeFileKey) {
    resetActiveGeometry();
  }
  savedActiveFileBeforeHistory = null;

  // loadSTL/resetActiveGeometry above land on Stage 1 or 2 as a side effect
  // of restoring the model — pull back to Stage 4 for the active run's monitor.
  unlockStage(4);
  switchStage(4);

  viewingHistoryReadOnly = false;
  activeJobId = savedActiveJobIdBeforeHistory;
  savedActiveJobIdBeforeHistory = null;

  const banner = document.getElementById('history-readonly-banner');
  if (banner) banner.style.display = 'none';

  if (activeJobId) {
    startCfdPolling();
  }
}

async function startCfdSimulation() {
  if (!activeFileKey) {
    alert("Please load a geometry model first.");
    return;
  }

  // Starting a fresh run always takes over Stage 4 for real — drop any
  // read-only historical view so it can't shadow the new run's polling.
  viewingHistoryReadOnly = false;
  savedActiveJobIdBeforeHistory = null;
  const historyBanner = document.getElementById('history-readonly-banner');
  if (historyBanner) historyBanner.style.display = 'none';

  const btnRunCfd = document.getElementById('btn-run-cfd');
  if (!btnRunCfd) return;
  btnRunCfd.disabled = true;
  setRunCfdButtonSpinnerLabel('Preparing');
  
  // Provide an immediate visual update in the Simulation Logs & Progress section
  showCfdMonitor(true);

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
        raceSpeedMph: raceSpeedMph,
        wheelbase: readWheelbase(),
        momentCentreX: currentMomentCentreX,
        fastCheck: fastCheckInput ? fastCheckInput.checked : false,
        runName: document.getElementById('run-name-input')?.value || '',
        purpose: document.getElementById('run-purpose-input')?.value || ''
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
    if (!viewingHistoryReadOnly) localStorage.setItem('caucsim_active_job_id', activeJobId);
    
    // Reset and show console/monitor with updated status
    if (consoleEl) {
      consoleEl.textContent = 'Launching droplet and configuring OpenFOAM environment...\n';
    }
    showCfdMonitor(true);
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

    updateRunCfdButtonState();
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

// --- Help modal ---
// Paged tutorial for pupils. Page content lives in help-content.js; this only
// renders one page at a time into the static shell in index.html, and always
// starts from page 1 (nothing is remembered between opens, by design).
// Elements are looked up inside each function, like closeLogModal, so the
// block between these markers is self-contained for help-modal.test.js.
let helpPageIndex = 0;

function isHelpModalOpen() {
  const modal = document.getElementById('help-modal');
  return !!modal && modal.style.display === 'flex';
}

function renderHelpPage(idx) {
  const total = HELP_PAGES.length;
  if (!total) return;
  helpPageIndex = Math.min(Math.max(idx, 0), total - 1);
  const page = HELP_PAGES[helpPageIndex];

  document.getElementById('help-modal-title').textContent = page.title;
  document.getElementById('help-modal-subtitle').textContent = `Page ${helpPageIndex + 1} of ${total}`;

  const img = document.getElementById('help-image');
  img.src = page.image;
  img.alt = page.alt;

  // page.body is static, trusted HTML from help-content.js — never user data.
  const text = document.getElementById('help-text');
  text.innerHTML = page.body;
  text.scrollTop = 0;

  document.getElementById('btn-help-prev').disabled = helpPageIndex === 0;
  document.getElementById('btn-help-next').textContent = helpPageIndex === total - 1 ? 'Finish' : 'Next';

  document.getElementById('help-dots').innerHTML = HELP_PAGES.map((p, i) =>
    `<button type="button" class="help-dot${i === helpPageIndex ? ' active' : ''}" data-help-page="${i}" aria-label="Page ${i + 1}: ${p.title}" title="${p.title}"></button>`
  ).join('');
}

function helpPrev() {
  renderHelpPage(helpPageIndex - 1);
}

function helpNext() {
  if (helpPageIndex >= HELP_PAGES.length - 1) {
    closeHelpModal();
    return;
  }
  renderHelpPage(helpPageIndex + 1);
}

function openHelpModal() {
  renderHelpPage(0);
  document.getElementById('help-modal').style.display = 'flex';
  document.getElementById('btn-help-next').focus();
}

function closeHelpModal() {
  if (!isHelpModalOpen()) return;
  document.getElementById('help-modal').style.display = 'none';
  const btn = document.getElementById('btn-help');
  if (btn && btn.style.display !== 'none') btn.focus();
}
// --- End help modal ---

// --- Chart zoom modal ---
// Click-to-enlarge for the Results panel's two charts and the centreline flow
// image. Charts are re-drawn at the modal's size (not scaled up) so the text
// stays crisp; the flow image is simply shown at full size.
const CHART_ZOOM_TITLES = {
  forces: 'Aerodynamic Forces vs. Speed',
  power: 'Aerodynamic Power Demand',
  flow: 'Centreline Flow Visualisation'
};
let chartModalKind = null;

function isChartModalOpen() {
  const modal = document.getElementById('chart-modal');
  return !!modal && modal.style.display === 'flex';
}

// Does the box have something worth enlarging yet? The flow image is hidden
// until a run has produced one; the charts always draw (with defaults) once
// stage 4 is reachable, so only the image needs a check.
function chartZoomAvailable(kind) {
  if (kind !== 'flow') return true;
  const img = document.getElementById('flow-visualisation-img');
  return !!img && img.style.display !== 'none' && !!img.getAttribute('src');
}

function renderChartModal() {
  if (!chartModalKind) return;
  const body = document.getElementById('chart-modal-body');
  const svgHost = document.getElementById('chart-modal-svg');
  const img = document.getElementById('chart-modal-img');
  if (!body || !svgHost || !img) return;

  if (chartModalKind === 'flow') {
    svgHost.style.display = 'none';
    svgHost.innerHTML = '';
    img.src = document.getElementById('flow-visualisation-img').src;
    img.style.display = 'block';
    return;
  }

  img.style.display = 'none';
  img.removeAttribute('src');
  svgHost.style.display = 'block';
  const w = body.clientWidth || 900;
  const h = body.clientHeight || 500;
  // Grow paddings/markers with the canvas, but not so much that a 2x-wide
  // chart gets 2x margins.
  const scale = Math.max(1, Math.min(2, w / 500));
  const { cdaVal, claVal } = readChartCoefficients();
  const svgs = buildPerformanceChartSvgs(w, h, cdaVal, claVal, scale);
  svgHost.innerHTML = chartModalKind === 'forces' ? svgs.forces : svgs.power;
}

function openChartModal(kind) {
  if (!CHART_ZOOM_TITLES[kind] || !chartZoomAvailable(kind)) return;
  chartModalKind = kind;
  const box = document.querySelector(`.chart-box[data-zoom="${kind}"]`);
  const desc = box ? box.querySelector('.chart-desc') : null;
  document.getElementById('chart-modal-title').textContent = CHART_ZOOM_TITLES[kind];
  document.getElementById('chart-modal-subtitle').innerHTML = desc ? desc.innerHTML : '';
  const modal = document.getElementById('chart-modal');
  modal.style.display = 'flex';
  // Layout must happen before the body has a size to draw into.
  renderChartModal();
  document.getElementById('btn-close-chart').focus();
}

function closeChartModal() {
  if (!isChartModalOpen()) return;
  const modal = document.getElementById('chart-modal');
  modal.style.display = 'none';
  document.getElementById('chart-modal-svg').innerHTML = '';
  document.getElementById('chart-modal-img').removeAttribute('src');
  const box = chartModalKind ? document.querySelector(`.chart-box[data-zoom="${chartModalKind}"]`) : null;
  chartModalKind = null;
  if (box) box.focus();
}
// --- End chart zoom modal ---

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

  // Mirror the live status onto the Run button too while it's genuinely
  // in flight -- once the job reaches a terminal state, displayCfdResults /
  // displayFailedCfdState own the button's label (and re-enable it) instead.
  const btnRunCfd = document.getElementById('btn-run-cfd');
  if (btnRunCfd && btnRunCfd.disabled && job.status !== 'completed' && job.status !== 'failed') {
    setRunCfdButtonSpinnerLabel(stageName);
  }

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

  flowVisLoadToken++;
  const requestToken = flowVisLoadToken;

  try {
    const res = await fetch(`/api/jobs/${jobId}/visualisation?json=true`, {
      headers: {
        'Authorization': `Bearer ${idToken || ''}`
      }
    });

    // The user may have loaded a different model or run while this was in
    // flight — a stale response must not overwrite what's now on screen.
    if (requestToken !== flowVisLoadToken) return;

    if (res.ok) {
      const data = await res.json();

      if (requestToken !== flowVisLoadToken) return;

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

// Keeps one streamline set's toggle button, its visible flag, and its loaded
// scene's visibility in sync from every call site. Sets are multi-select --
// each is independent, no shared radio state.
function setStreamlinesVisible(setName, visible) {
  const set = streamlineSets[setName];
  if (!set) return;
  set.visible = visible;
  const btn = document.getElementById(`toggle-streamlines-${setName}`);
  if (btn) btn.classList.toggle('active', visible);
  if (set.scene) {
    set.scene.visible = visible;
  }
}

function setStreamlineAvailable(setName, available) {
  const set = streamlineSets[setName];
  if (!set) return;
  set.available = available;
  const btn = document.getElementById(`toggle-streamlines-${setName}`);
  if (btn) btn.disabled = !available;
}

function clearStreamlineScenes() {
  streamlineLoadToken++;
  STREAMLINE_SET_NAMES.forEach(setName => {
    const set = streamlineSets[setName];
    if (set.scene) {
      scene.remove(set.scene);
      set.scene = null;
    }
    setStreamlinesVisible(setName, false);
    setStreamlineAvailable(setName, false);
  });
}

async function fetchStreamlineSet(jobId, setName, requestToken) {
  try {
    const res = await fetch(`/api/jobs/${jobId}/streamlines-model?set=${setName}&json=true`, {
      headers: {
        'Authorization': `Bearer ${idToken || ''}`
      }
    });

    // Older jobs only have the "current" set's GLTF -- a 404 on centreline
    // or outboard just means that button stays disabled for this run.
    if (!res.ok) return;

    const data = await res.json();
    const loader = new GLTFLoader();
    loader.load(data.url, (gltf) => {
      // The user may have loaded a different model or run while this GLTF was
      // still downloading — a stale load must not add itself to the scene.
      if (requestToken !== streamlineLoadToken) return;
      const streamlineScene = gltf.scene;
      // ParaView exports in meters; the app's world units are millimeters (matches loadSTL's m->mm scaling)
      streamlineScene.scale.set(1000, 1000, 1000);
      streamlineScene.position.set(0, 0, 0);
      streamlineSets[setName].scene = streamlineScene;
      scene.add(streamlineScene);
      setStreamlineAvailable(setName, true);
      // "current" is the pre-existing set users already expect to see as
      // soon as a run's model arrives; the two new sets start hidden so the
      // view isn't unexpectedly busier than before for existing users.
      setStreamlinesVisible(setName, setName === 'current');
    }, undefined, (err) => {
      console.error(`Error loading '${setName}' streamlines scene:`, err);
    });
  } catch (err) {
    console.error(`Failed to fetch '${setName}' streamlines model:`, err);
  }
}

function fetchStreamlinesModel(jobId) {
  clearStreamlineScenes();
  const requestToken = streamlineLoadToken;
  STREAMLINE_SET_NAMES.forEach(setName => {
    fetchStreamlineSet(jobId, setName, requestToken);
  });
}

// Keeps the pressure toggle button, state flag, legend, and loaded scene's
// visibility in sync. The overlay replaces whichever Shaded/Wire/Points
// representation is currently shown (they'd otherwise overlap/z-fight), so
// this also hides those and disables their buttons while pressure is on,
// restoring them via updateRenderMode() when it's turned back off.
function setPressureVisible(visible) {
  pressureToggleActive = visible;
  const btn = document.getElementById('toggle-pressure');
  if (btn) btn.classList.toggle('active', visible);

  const legend = document.getElementById('pressure-legend');
  if (legend) legend.style.display = visible ? 'flex' : 'none';

  document.querySelectorAll('[data-render-mode]').forEach(b => { b.disabled = visible; });

  if (visible) {
    if (activeMesh) scene.remove(activeMesh);
    if (activeWireframe) scene.remove(activeWireframe);
    if (activePoints) scene.remove(activePoints);
    if (activePressureScene) activePressureScene.visible = true;
  } else {
    if (activePressureScene) activePressureScene.visible = false;
    updateRenderMode();
  }
}

function setPressureAvailable(available) {
  pressureAvailable = available;
  const btn = document.getElementById('toggle-pressure');
  if (btn) btn.disabled = !available;
}

function clearPressureScene() {
  pressureLoadToken++;
  if (activePressureScene) {
    scene.remove(activePressureScene);
    activePressureScene = null;
  }
  setPressureVisible(false);
  setPressureAvailable(false);
  const legendMin = document.getElementById('pressure-legend-min');
  const legendMax = document.getElementById('pressure-legend-max');
  if (legendMin) legendMin.textContent = '';
  if (legendMax) legendMax.textContent = '';
}

// Takes the job object (not just its id) because the Cp legend's min/max
// come from job.metrics.cpMin/cpMax, lazily derived server-side from the
// pressure_range.json sidecar (see computePressureRangeFromResults in
// backend/app/app.js) -- absent entirely for jobs run before this feature
// shipped.
async function fetchPressureModel(job) {
  clearPressureScene();
  const requestToken = pressureLoadToken;
  const jobId = job.jobId;
  try {
    const res = await fetch(`/api/jobs/${jobId}/pressure-model?json=true`, {
      headers: {
        'Authorization': `Bearer ${idToken || ''}`
      }
    });

    if (!res.ok) return;

    const data = await res.json();
    const loader = new GLTFLoader();
    loader.load(data.url, (gltf) => {
      if (requestToken !== pressureLoadToken) return;
      const pressureScene = gltf.scene;
      // ParaView exports in meters; the app's world units are millimeters (matches loadSTL's m->mm scaling)
      pressureScene.scale.set(1000, 1000, 1000);
      pressureScene.position.set(0, 0, 0);
      pressureScene.visible = false;
      activePressureScene = pressureScene;
      scene.add(pressureScene);
      setPressureAvailable(true);

      const legendMin = document.getElementById('pressure-legend-min');
      const legendMax = document.getElementById('pressure-legend-max');
      const cpMin = job.metrics && typeof job.metrics.cpMin === 'number' ? job.metrics.cpMin : null;
      const cpMax = job.metrics && typeof job.metrics.cpMax === 'number' ? job.metrics.cpMax : null;
      if (legendMin && cpMin !== null) legendMin.textContent = cpMin.toFixed(2);
      if (legendMax && cpMax !== null) legendMax.textContent = cpMax.toFixed(2);
    }, undefined, (err) => {
      console.error('Error loading surface pressure scene:', err);
    });
  } catch (err) {
    console.error("Failed to fetch pressure model:", err);
  }
}

function showResultsSummary(hasResults) {
  const emptyEl = document.getElementById('results-details-empty');
  const loadedEl = document.getElementById('results-details-loaded');
  if (emptyEl) emptyEl.style.display = hasResults ? 'none' : 'flex';
  if (loadedEl) loadedEl.style.display = hasResults ? 'block' : 'none';
}

// Render a coefficient as "0.267 ± 0.003" when the run reported a spread,
// falling back to a bare value for jobs from before spreads were recorded.
function formatCoefficient(value, std) {
  if (typeof std !== 'number' || !isFinite(std)) return value.toFixed(3);
  return `${value.toFixed(3)} ± ${std.toFixed(3)}`;
}

// Say plainly how much the numbers above can be trusted. A fast check and an
// unconverged solve are different problems, and a fast check is always both.
function renderResultBanner(m) {
  const banner = document.getElementById('cfd-result-banner');
  if (!banner) return;

  let tone = null;
  let text = '';

  if (m.metricsError) {
    tone = 'warn';
    text = `<strong>No results available.</strong> ${m.metricsError}`;
  } else if (m.fastCheck) {
    tone = 'warn';
    text = '<strong>Fast check run.</strong> Coarse mesh and a short solve — useful to confirm the model runs, but these numbers are not accurate. Re-run with Fast check unticked for a result you can use.';
  } else if (m.converged === false) {
    tone = 'warn';
    text = '<strong>Not converged.</strong> The solution was still changing when the run ended, so these coefficients are a snapshot rather than a settled answer. Treat them as provisional.';
  } else if (m.converged === true) {
    tone = 'ok';
    const n = m.sampleCount || 0;
    text = `<strong>Converged.</strong> Averaged over the final ${n} iterations; the ± figures show how much the flow was still oscillating.`;
  }

  if (!tone) {
    banner.style.display = 'none';
    return;
  }

  const warn = tone === 'warn';
  banner.style.color = warn ? 'var(--danger-color)' : 'var(--accent-cyan)';
  banner.style.background = warn ? 'rgba(255, 61, 0, 0.05)' : 'rgba(0, 229, 255, 0.05)';
  banner.style.border = `1px solid ${warn ? 'rgba(255, 61, 0, 0.15)' : 'var(--accent-cyan-glow)'}`;
  banner.innerHTML = text;
  banner.style.display = 'block';
}

function displayCfdResults(job) {
  showCfdMonitor(false);
  showResultsSummary(true);

  if (job && job.jobId) {
    fetchFlowVisualisation(job.jobId);
    fetchStreamlinesModel(job.jobId);
    fetchPressureModel(job);
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
  if (!m || job.metricsError) {
    // The run finished but the coefficients could not be derived. Say so —
    // an empty panel with no explanation is worse than no panel at all.
    renderResultBanner({ metricsError: job.metricsError || 'No aerodynamic results were produced for this run. Check the run log.' });
    return;
  }

  const density = 1.225; // kg/m³
  const speed = jobSpeedMph * MPH_TO_MS;

  const cdVal = m.cd !== undefined ? m.cd : 0;
  const clVal = m.cl !== undefined ? m.cl : 0;
  const cdaVal = m.cda !== undefined ? m.cda : (cdVal * (m.aref || 0.197));
  const claVal = m.cla !== undefined ? m.cla : (clVal * (m.aref || 0.197));
  
  const dragForce = m.dragForce !== undefined ? m.dragForce : (0.5 * density * speed * speed * cdaVal);
  const liftForce = m.liftForce !== undefined ? m.liftForce : (0.5 * density * speed * speed * claVal);
  const aeroPower = m.aeroPower !== undefined ? m.aeroPower : (dragForce * speed);
  
  // Show the spread when the run reports one. A steady solve of a bluff body
  // keeps oscillating even once converged, so the value is a mean over the
  // final iterations and the ± is how much it was still moving by.
  document.getElementById('cfd-cd').textContent = formatCoefficient(cdVal, m.cdStd);
  document.getElementById('cfd-cda').textContent = cdaVal.toFixed(4) + ' m²';
  document.getElementById('cfd-cl').textContent = formatCoefficient(clVal, m.clStd);
  document.getElementById('cfd-cla').textContent = claVal.toFixed(4) + ' m²';

  renderResultBanner(m);
  
  document.getElementById('cfd-drag-force').textContent = dragForce.toFixed(1) + ' N';
  document.getElementById('cfd-lift-force').textContent = liftForce.toFixed(1) + ' N';
  document.getElementById('cfd-power').textContent = aeroPower.toFixed(0) + ' W';
  
  const btnRunCfd = document.getElementById('btn-run-cfd');
  if (btnRunCfd) {
    updateRunCfdButtonState();
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
  const consoleEl = document.getElementById('cfd-console');
  if (consoleEl) {
    consoleEl.textContent += `\n\n[ERROR] CFD Simulation failed: ${job.error || 'Unknown Error'}\n`;
    scrollConsoleToBottom(consoleEl);
  }
  
  const btnRunCfd = document.getElementById('btn-run-cfd');
  if (btnRunCfd) {
    updateRunCfdButtonState();
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
  if (!viewingHistoryReadOnly) localStorage.removeItem('caucsim_active_job_id');
  showCfdMonitor(false);
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

  // Clear 3D streamlines and pressure overlay from the viewport
  clearStreamlineScenes();
  clearPressureScene();

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
    updateRunCfdButtonState();
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
  if (historyModal) {
    historyModal.addEventListener('click', (e) => {
      if (e.target === historyModal) historyModal.style.display = 'none';
    });
  }
  const helpModal = document.getElementById('help-modal');
  if (helpModal) {
    document.getElementById('btn-close-help').addEventListener('click', closeHelpModal);
    document.getElementById('btn-help-prev').addEventListener('click', helpPrev);
    document.getElementById('btn-help-next').addEventListener('click', helpNext);
    document.getElementById('help-dots').addEventListener('click', (e) => {
      const dot = e.target.closest('[data-help-page]');
      if (dot) renderHelpPage(parseInt(dot.dataset.helpPage, 10));
    });
    helpModal.addEventListener('click', (e) => {
      if (e.target === helpModal) closeHelpModal();
    });
  }

  const chartModal = document.getElementById('chart-modal');
  if (chartModal) {
    document.getElementById('btn-close-chart').addEventListener('click', closeChartModal);
    chartModal.addEventListener('click', (e) => {
      if (e.target === chartModal) closeChartModal();
    });
    document.querySelectorAll('.chart-box[data-zoom]').forEach((box) => {
      box.addEventListener('click', () => openChartModal(box.dataset.zoom));
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openChartModal(box.dataset.zoom);
        }
      });
    });
  }

  // --- Overlay keyboard shortcuts ---
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeLogModal();
      if (historyModal) historyModal.style.display = 'none';
      closeHelpModal();
      closeChartModal();
      return;
    }
    // Arrow keys only page the tutorial while it is open. They go through
    // renderHelpPage (clamped) rather than helpNext, so an extra right-arrow on
    // the last page does not close the dialog — only the Finish button does.
    if (!isHelpModalOpen()) return;
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      renderHelpPage(helpPageIndex + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      renderHelpPage(helpPageIndex - 1);
    }
  });
  // --- End overlay keyboard shortcuts ---
  
  if (btnRunCfd) {
    btnRunCfd.addEventListener('click', startCfdSimulation);
    updateRunCfdButtonState();
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
  
  // Both the summary and the CSV history need the bearer token, so neither can
  // be a plain href: fetch with auth, then hand the browser a blob to save.
  const bindAuthedDownload = (linkId, buildUrl, fallbackName, failureMessage) => {
    const link = document.getElementById(linkId);
    if (!link) return;

    link.addEventListener('click', async (e) => {
      e.preventDefault();
      if (!activeJobId) return;

      try {
        link.style.pointerEvents = 'none';
        link.style.opacity = '0.5';

        const res = await fetch(buildUrl(activeJobId), {
          headers: {
            'Authorization': `Bearer ${idToken || ''}`
          }
        });

        if (!res.ok) {
          // The server explains a missing history; prefer its wording.
          let detail = '';
          try {
            const body = await res.json();
            if (body && body.error) detail = ` ${body.error}`;
          } catch (parseErr) { /* not JSON; the generic message will do */ }
          alert(`${failureMessage}${detail}`);
          return;
        }

        const disposition = res.headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="([^"]+)"/);
        const filename = match ? match[1] : fallbackName(activeJobId);

        const blobUrl = URL.createObjectURL(new Blob([await res.text()], { type: 'text/plain' }));
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);
      } catch (err) {
        console.error(err);
        alert(failureMessage);
      } finally {
        link.style.pointerEvents = 'auto';
        link.style.opacity = '1';
      }
    });
  };

  bindAuthedDownload(
    'lnk-download-summary',
    (jobId) => `/api/jobs/${jobId}/summary`,
    (jobId) => `caucsim-summary-${jobId}.md`,
    'Failed to generate the summary.'
  );

  bindAuthedDownload(
    'lnk-download-history',
    (jobId) => `/api/jobs/${jobId}/history`,
    (jobId) => `caucsim-history-${jobId}.csv`,
    'Failed to download the force history.'
  );

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
    }).then(res => res.json()).then(async (job) => {
      // activeJobId survives a reload via localStorage, but activeFileKey
      // does not -- without this, restoring a completed/running job here
      // shows its results/monitor over a viewport that never loaded the
      // model it belongs to. Mirrors viewHistoricalJob's approach: loadSTL
      // (via fetchLibrary) calls clearCfdRun on the fileKey change, which
      // nulls activeJobId and would pop the "discard this run?" prompt for
      // what isn't really a swap, so viewingHistoryReadOnly suppresses both
      // while this runs, and activeJobId is restored once the geometry has
      // loaded (awaited so it -- and loadSTL's own switchStage(1) -- finish
      // before the status-based switchStage below runs).
      if (job.fileKey && job.fileKey !== activeFileKey) {
        const wasReadOnly = viewingHistoryReadOnly;
        viewingHistoryReadOnly = true;
        await fetchLibrary(job.fileKey);
        viewingHistoryReadOnly = wasReadOnly;
        activeJobId = job.jobId;
      }

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
  updateRunCfdButtonState();
};

// --- App Bootstrap ---
function bootstrapApp() {
  initResizablePanels();
  initThree();
  bindEvents();
  checkStorageStatus();
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootstrapApp);
} else {
  bootstrapApp();
}
