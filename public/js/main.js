import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// --- State Management ---
let scene, camera, renderer, controls;
let activeMesh = null;
let activePoints = null;
let activeWireframe = null;
let activeGeometry = null; // Store geometry for volume recalculations
let gridHelper, axesHelper;
let currentRenderMode = 'shaded'; // 'shaded' | 'wireframe' | 'points'
let activeFilename = null;
let activeUrl = null;
let activeFileKey = null;
let currentFrontalArea = 0;

// Authentication State
let idToken = localStorage.getItem('caucsim_id_token') || null;
let authMode = 'mock'; // 'cognito' | 'mock'
let cognitoConfig = null;



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
const searchInput = document.getElementById('library-search-input');
const refreshBtn = document.getElementById('refresh-library-btn');
const cdInput = document.getElementById('cd-input');

// Auth Elements
const authModal = document.getElementById('auth-modal');
const authForm = document.getElementById('auth-form');
const authEmail = document.getElementById('auth-email');
const authPassword = document.getElementById('auth-password');
const authError = document.getElementById('auth-error');
const btnLoginSubmit = document.getElementById('btn-login-submit');
const btnMockLogin = document.getElementById('btn-mock-login');
const btnLogout = document.getElementById('btn-logout');

// Stats Elements
const statTriangles = document.getElementById('stat-triangles');
const statVertices = document.getElementById('stat-vertices');
const statVolume = document.getElementById('stat-volume');
const statSurfaceArea = document.getElementById('stat-surface-area');
const statFrontalArea = document.getElementById('stat-frontal-area');
const statCdA = document.getElementById('stat-cda');
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
const regSummary = document.getElementById('reg-summary');

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

  const loader = new STLLoader();
  
  // Show a loading text in title
  activeModelTitle.innerHTML = `Loading 3D mesh... <span style="font-size:11px; opacity:0.7;">(${originalName})</span>`;

  loader.load(
    viewUrl,
    (geometry) => {
      // Calculate unit scaling if necessary (Auto-detect or manual Meter scaling)
      geometry.computeBoundingBox();
      const tempSize = new THREE.Vector3();
      geometry.boundingBox.getSize(tempSize);
      const maxDimUnit = Math.max(tempSize.x, tempSize.y, tempSize.z);

      const unitSelect = document.getElementById('unit-select');
      const selectedUnit = unitSelect ? unitSelect.value : 'auto';
      let shouldScaleToMM = false;

      if (selectedUnit === 'auto') {
        // If the longest dimension is less than 15 units (e.g. 2.7m), assume meters
        if (maxDimUnit < 15) {
          shouldScaleToMM = true;
        }
      } else if (selectedUnit === 'm') {
        shouldScaleToMM = true;
      }

      if (shouldScaleToMM) {
        geometry.scale(1000, 1000, 1000);
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
    },
    (xhr) => {
      // Progress handler
      if (xhr.lengthComputable) {
        const percent = Math.round((xhr.loaded / xhr.total) * 100);
        activeModelTitle.innerHTML = `Parsing geometry: ${percent}%...`;
      }
    },
    (err) => {
      console.error(err);
      activeModelTitle.textContent = 'Error rendering 3D file';
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
  updateCdA(frontalAreaM2);

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

  // Overall regulations validation summary
  if (l <= 2400 && w <= 900 && isWatertight) {
    regSummary.textContent = 'PASSED F24 DIMENSIONAL LIMITS';
    regSummary.className = 'reg-summary-box pass';
  } else {
    let reasons = [];
    if (l > 2400) reasons.push('Length exceeds limit');
    if (w > 900) reasons.push('Width exceeds limit');
    if (!isWatertight) reasons.push('Mesh not watertight');
    regSummary.textContent = 'FAILED RULES: ' + reasons.join(' & ');
    regSummary.className = 'reg-summary-box fail';
  }
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

function updateCdA(frontalAreaM2) {
  currentFrontalArea = frontalAreaM2;
  const cdVal = parseFloat(cdInput.value);
  if (currentFrontalArea > 0 && !isNaN(cdVal)) {
    const cda = currentFrontalArea * cdVal;
    statCdA.textContent = cda.toFixed(4) + ' m²';
  } else {
    statCdA.textContent = '-';
  }
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
            clearActiveGeometry();
            viewportPlaceholder.style.display = 'flex';
            dimensionLabels.style.display = 'none';
            activeModelTitle.textContent = 'No Geometry Loaded';
            activeModelStatus.style.display = 'none';
            activeFileKey = null;
            
            // Clear stats
            statTriangles.textContent = '-';
            statVertices.textContent = '-';
            statVolume.textContent = '-';
            statSurfaceArea.textContent = '-';
            statFrontalArea.textContent = '-';
            statCdA.textContent = '-';
            currentFrontalArea = 0;
            dimLen.textContent = '-';
            dimHei.textContent = '-';
            dimWid.textContent = '-';
            regLenVal.textContent = '-';
            regWidVal.textContent = '-';
            regHeiVal.textContent = '-';
            regWatertightVal.textContent = 'Not Checked';
            regSummary.textContent = 'No geometry loaded';
            regSummary.className = 'reg-summary-box';
            document.querySelectorAll('.reg-item').forEach(el => el.className = 'reg-item');
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

// --- Event Listeners and Triggers ---
function bindEvents() {
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

  // Search filter
  searchInput.addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase();
    document.querySelectorAll('.model-item').forEach(item => {
      const name = item.querySelector('.model-item-name').textContent.toLowerCase();
      if (name.includes(query)) {
        item.style.display = 'flex';
      } else {
        item.style.display = 'none';
      }
    });
  });

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

  // Cd input change listener
  cdInput.addEventListener('input', () => {
    updateCdA(currentFrontalArea);
  });

  // Unit Mode Selector change
  const unitSelect = document.getElementById('unit-select');
  unitSelect.addEventListener('change', () => {
    if (activeFilename && activeUrl && activeFileKey) {
      loadSTL(activeFilename, activeUrl, activeFileKey);
    }
  });
}

async function checkStorageStatus() {
  const storageStatusEl = document.getElementById('storage-status');
  const storageStatusVal = document.getElementById('storage-status-val');
  
  if (!storageStatusEl || !storageStatusVal) return;

  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error();
    const data = await response.json();
    
    if (data.storage === 'aws-s3') {
      storageStatusEl.className = 'status-indicator online';
      storageStatusVal.textContent = 'AWS S3';
      storageStatusEl.title = `S3 Bucket: ${data.bucket || 'unknown'}\nRegion: ${data.region || 'unknown'}`;
    } else {
      storageStatusEl.className = 'status-indicator standby';
      storageStatusVal.textContent = 'Local (Mock)';
      storageStatusEl.title = 'AWS S3 is not configured. Running in Local Disk Mock Mode.';
    }
  } catch (err) {
    storageStatusEl.className = 'status-indicator offline';
    storageStatusVal.textContent = 'Disconnected';
    storageStatusEl.title = 'Could not connect to storage provider status API.';
  }
}

async function checkStorageStatus() {
  const storageStatusEl = document.getElementById('storage-status');
  const storageStatusVal = document.getElementById('storage-status-val');
  
  if (!storageStatusEl || !storageStatusVal) return;

  try {
    const response = await fetch('/api/status');
    if (!response.ok) throw new Error();
    const data = await response.json();
    
    // Parse Auth Configuration
    authMode = data.authMode || 'mock';
    cognitoConfig = data.cognito;
    
    if (authMode === 'mock') {
      btnMockLogin.style.display = 'block';
    } else {
      btnMockLogin.style.display = 'none';
    }
    
    if (data.storage === 'aws-s3') {
      storageStatusEl.className = 'status-indicator online';
      storageStatusVal.textContent = 'AWS S3';
      storageStatusEl.title = `S3 Bucket: ${data.bucket || 'unknown'}\nRegion: ${data.region || 'unknown'}`;
    } else {
      storageStatusEl.className = 'status-indicator standby';
      storageStatusVal.textContent = 'Local (Mock)';
      storageStatusEl.title = 'AWS S3 is not configured. Running in Local Disk Mock Mode.';
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
  
  // Clear Three.js scene
  clearActiveGeometry();
  viewportPlaceholder.style.display = 'flex';
  dimensionLabels.style.display = 'none';
  activeModelTitle.textContent = 'No Geometry Loaded';
  activeModelStatus.style.display = 'none';
  activeFileKey = null;
  
  // Clear Stats UI
  statTriangles.textContent = '-';
  statVertices.textContent = '-';
  statVolume.textContent = '-';
  statSurfaceArea.textContent = '-';
  statFrontalArea.textContent = '-';
  statCdA.textContent = '-';
  currentFrontalArea = 0;
  dimLen.textContent = '-';
  dimHei.textContent = '-';
  dimWid.textContent = '-';
  regLenVal.textContent = '-';
  regWidVal.textContent = '-';
  regHeiVal.textContent = '-';
  regWatertightVal.textContent = 'Not Checked';
  regSummary.textContent = 'No geometry loaded';
  regSummary.className = 'reg-summary-box';
  document.querySelectorAll('.reg-item').forEach(el => el.className = 'reg-item');
  
  libraryList.innerHTML = '';
  libraryEmpty.style.display = 'block';

  validateSession();
}

// Bind Auth UI event listeners
authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.style.display = 'none';
  btnLoginSubmit.disabled = true;
  btnLoginSubmit.textContent = 'Signing in...';
  
  const email = authEmail.value.trim();
  const password = authPassword.value;
  
  if (authMode === 'mock') {
    // Mock login bypass helper: accept any credentials
    if (email && password) {
      handleLoginSuccess('mock-session-token');
    } else {
      showAuthError('Email and password are required.');
    }
  } else {
    // Production Cognito HTTP flow
    try {
      const cognitoUrl = `https://cognito-idp.${cognitoConfig.region}.amazonaws.com/`;
      const response = await fetch(cognitoUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-amz-json-1.1',
          'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth'
        },
        body: JSON.stringify({
          AuthFlow: 'USER_PASSWORD_AUTH',
          ClientId: cognitoConfig.clientId,
          AuthParameters: {
            USERNAME: email,
            PASSWORD: password
          }
        })
      });
      
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Cognito authentication failed');
      }
      
      const token = data.AuthenticationResult.IdToken;
      handleLoginSuccess(token);
    } catch (err) {
      showAuthError(err.message || 'Login failed. Please check credentials.');
    }
  }
});

btnMockLogin.addEventListener('click', () => {
  handleLoginSuccess('mock-session-token');
});

btnLogout.addEventListener('click', handleLogout);

function handleLoginSuccess(token) {
  idToken = token;
  localStorage.setItem('caucsim_id_token', token);
  btnLoginSubmit.disabled = false;
  btnLoginSubmit.textContent = 'Sign In';
  authEmail.value = '';
  authPassword.value = '';
  validateSession();
}

function showAuthError(msg) {
  authError.textContent = msg;
  authError.style.display = 'block';
  btnLoginSubmit.disabled = false;
  btnLoginSubmit.textContent = 'Sign In';
}

// --- App Bootstrap ---
window.addEventListener('DOMContentLoaded', () => {
  initThree();
  bindEvents();
  checkStorageStatus();
});
