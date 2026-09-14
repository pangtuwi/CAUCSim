// Tutorial pages for the Help modal (see "// --- Help modal ---" in main.js).
//
// Each page: { id, title, image, alt, body }
//   title  - shown in the modal header
//   image  - path relative to index.html, no leading slash (so it still works
//            if the frontend is later served under a CloudFront /cfd/ prefix)
//   alt    - one-sentence description of the screenshot for screen readers
//   body   - static HTML in a template literal (no backticks inside the prose).
//            It is set with innerHTML, so never put user data in here.
//
// Screenshots live in frontend/cfd/help/ and are captured from a ~1414x782
// viewport (then saved as JPEG q90 with `sips`). Regenerate them when
// the UI changes noticeably; keep each under ~350 KB because the whole
// frontend folder ships inside the Lambda package.
//
// The wording is aimed at F24 pupils (11-17): say what a number means before
// saying where to find it.

export const HELP_PAGES = [
  {
    id: 'overview',
    title: 'Welcome to CAUCSim',
    image: 'help/01-overview.jpg',
    alt: 'The whole CAUCSim screen: header with status pills, four numbered stage tabs, and the Input, View and Results columns with a car model in the 3D view.',
    body: `
      <h3>What is this?</h3>
      <p>CAUCSim is a <strong>computer wind tunnel</strong>. You give it a 3D model of your F24 car and it works out how the air flows around it, how much drag the car makes, and how much power that drag costs you at race speed.</p>
      <h3>How the screen is laid out</h3>
      <ul>
        <li><strong>Header</strong> &mdash; the two status pills tell you whether the CAD storage and the OpenFOAM engine (the program that does the maths) are ready.</li>
        <li><strong>Four stage tabs</strong> &mdash; <em>01 CAD Model</em>, <em>02 Geometry Check</em>, <em>03 CFD Simulation</em>, <em>04 Results</em>. They unlock in order as you complete each step.</li>
        <li><strong>Input</strong> (left) &mdash; where you choose things and press buttons.</li>
        <li><strong>View</strong> (middle) &mdash; the 3D picture of your car.</li>
        <li><strong>Results</strong> (right) &mdash; numbers, checks and charts for the current stage.</li>
      </ul>
      <h3>Using this guide</h3>
      <p>Click <strong>Next</strong> or the dots below, or press <kbd>&rarr;</kbd> and <kbd>&larr;</kbd>. Press <kbd>Esc</kbd> to close. The <strong>Help</strong> button is always in the top-right corner if you want to come back.</p>
    `,
  },
  {
    id: 'cad-model',
    title: '01 · Choose your car',
    image: 'help/02-cad-model.jpg',
    alt: 'Stage 01 with the model library list, the units dropdown and the drag-and-drop upload box on the left, and the model statistics in the Results column.',
    body: `
      <h3>Pick a model</h3>
      <p>Choose a car from the <strong>library list</strong>, or add your own by dragging an <strong>STL file</strong> onto the upload box (or click <em>Browse</em>). STL is the file type most CAD programs can export. Files up to 500&nbsp;MB are fine.</p>
      <h3>Check the units</h3>
      <p>An STL file does not say whether its numbers are millimetres or metres, so tell CAUCSim with the <strong>Model Units</strong> dropdown. Get this wrong and your 2.4&nbsp;m car becomes a 2.4&nbsp;mm toy. The wind tunnel itself needs the model in <strong>metres</strong>, so export it that way from your CAD program &mdash; the other units are only for looking at a model, and the next stage will flag them.</p>
      <h3>What the Results column shows</h3>
      <ul>
        <li><strong>Triangles / vertices</strong> &mdash; how detailed the model is. More triangles means a smoother surface but a slower simulation.</li>
        <li><strong>Bounding box</strong> &mdash; the length, width and height of the smallest box the car fits in.</li>
        <li><strong>Surface area</strong> &mdash; the total skin of the car that the air rubs against.</li>
      </ul>
      <p class="help-tip">Once the model has loaded in the 3D view, press <strong>Continue to Geometry Check</strong>.</p>
    `,
  },
  {
    id: 'geometry-check',
    title: '02 · Geometry check',
    image: 'help/03-geometry-check.jpg',
    alt: 'Stage 02 Results column showing the projected frontal area and the F24 regulations checklist with pass and fail rows.',
    body: `
      <h3>Frontal area</h3>
      <p>Imagine shining a light at the car from straight ahead: the shadow it casts is the <strong>frontal area</strong>. It is the size of the hole your car has to punch through the air, so a smaller frontal area means less drag before you even think about the shape.</p>
      <h3>The F24 rules checklist</h3>
      <p>Each row compares your model with the competition rules and with what the simulation needs:</p>
      <ul>
        <li><strong>Length &le; 2400&nbsp;mm, Width &le; 900&nbsp;mm, Height</strong> &mdash; the size limits from the rulebook.</li>
        <li><strong>Watertight</strong> &mdash; the surface has no holes or gaps. Air would leak inside a model with holes and the results would be nonsense.</li>
        <li><strong>CFD scale</strong> &mdash; the model is in metres and a sensible real-world size (this is where a wrong unit setting shows up).</li>
        <li><strong>X position</strong> &mdash; the nose of the car is at the front of the virtual wind tunnel.</li>
        <li><strong>Y symmetry</strong> &mdash; the car is centred left-to-right.</li>
        <li><strong>Z ground plane</strong> &mdash; the wheels sit on the ground rather than floating or sinking.</li>
      </ul>
      <p class="help-tip">A red row means something needs fixing &mdash; usually back in your CAD program &mdash; before the simulation can run. When everything is green, press <strong>Continue to CFD Simulation</strong>.</p>
    `,
  },
  {
    id: 'cfd-simulation',
    title: '03 · Run the simulation',
    image: 'help/04-cfd-simulation.jpg',
    alt: 'Stage 03 with the run name, purpose, race speed and wheelbase inputs filled in on the left and the live progress bar and execution log in the Results column.',
    body: `
      <h3>Before you press Run</h3>
      <ul>
        <li><strong>Run name</strong> and <strong>Purpose</strong> &mdash; both are required. Say what you changed (for example <em>&ldquo;v3 &mdash; lower nose&rdquo;</em>) so your team can tell the runs apart later in Run History.</li>
        <li><strong>Race speed</strong> (mph) &mdash; the speed the air will blow at. Drag goes up with the <em>square</em> of speed, so doubling the speed makes four times the drag.</li>
        <li><strong>Wheelbase</strong> &mdash; the distance between the front and rear axles, pre-filled from your model.</li>
        <li><strong>Fast check</strong> &mdash; a rougher, quicker run. Good for a first look; use a full run for numbers you want to trust.</li>
      </ul>
      <h3>While it runs</h3>
      <p>The engine pill in the header walks through <strong>Queued &rarr; Initializing &rarr; Meshing &rarr; Solving &rarr; Processing</strong>. <em>Meshing</em> chops the air around the car into millions of tiny cells; <em>Solving</em> works out the airflow in every one of them, over and over, until the answer settles down. The live <strong>Execution Log</strong> shows the solver talking to itself &mdash; you do not need to read it, but it proves things are happening.</p>
      <p class="help-tip">Runs take a while because a cloud computer is switched on just for you. You can leave the page open and check back.</p>
    `,
  },
  {
    id: 'results',
    title: '04 · Read the results',
    image: 'help/05-results.jpg',
    alt: 'Stage 04 Results column showing the Cd, CdA, Cl and ClA cards, the drag and lift forces table, the forces-versus-speed and power charts, and the centreline flow slice image.',
    body: `
      <h3>The headline numbers</h3>
      <ul>
        <li><strong>Cd</strong> (drag coefficient) &mdash; how <em>slippery</em> the shape is, ignoring its size. Lower is better. A modern road car is about 0.25; a brick is about 2.</li>
        <li><strong>CdA</strong> &mdash; Cd multiplied by frontal area. This is the number that actually sets your drag: a small car with an average Cd can beat a big car with a brilliant one.</li>
        <li><strong>Cl / ClA</strong> (lift) &mdash; positive lift tries to pick the car up; negative lift (downforce) pushes it onto the track. For an F24 car, close to zero is usually what you want.</li>
        <li><strong>Drag force</strong> and <strong>aero power</strong> at your race speed &mdash; power is the bit of your battery that goes into pushing air out of the way. Going 10% faster needs about 33% more power.</li>
      </ul>
      <h3>Can I trust it?</h3>
      <p>Each number shows a <strong>&plusmn;</strong> spread from the last part of the run. A <strong>converged</strong> banner means the answer settled down; <strong>provisional</strong> means it was still wobbling, so treat the numbers as rough.</p>
      <h3>Pictures</h3>
      <p>The charts show how drag, lift and power change with speed. The <strong>centreline slice</strong> is a cut through the middle of the car: warm colours are fast air, cool colours are slow air, and the slow wake behind the car is what drag looks like. Turn on <strong>streamlines</strong> and <strong>surface Cp</strong> in the View toolbar to see the airflow in 3D.</p>
      <p class="help-tip"><strong>Download ZIP</strong> gives you the full case for ParaView, <strong>Download Summary</strong> a one-page report, <strong>Download History (CSV)</strong> a spreadsheet of all your runs, <strong>View Log</strong> the solver output, and <strong>Clear Run</strong> starts again.</p>
    `,
  },
  {
    id: 'viewport',
    title: 'The 3D view and tools',
    image: 'help/06-viewport-tools.jpg',
    alt: 'The View column toolbar with Render, View, Display and Overlays groups, the car shown in wireframe mode, and the drag handles between the three columns.',
    body: `
      <h3>Moving around</h3>
      <p><strong>Drag</strong> with the left mouse button to orbit, <strong>scroll</strong> to zoom, and <strong>right-drag</strong> to pan. The <strong>ISO / TOP / FRONT / SIDE</strong> buttons snap to a standard view.</p>
      <h3>Toolbar groups</h3>
      <ul>
        <li><strong>Render</strong> &mdash; <em>Solid</em>, <em>Wire</em> (see the triangles) or <em>Points</em>.</li>
        <li><strong>View</strong> &mdash; the preset camera angles.</li>
        <li><strong>Display</strong> &mdash; toggle the grid and the X/Y/Z axes.</li>
        <li><strong>Overlays</strong> &mdash; after a run, switch on streamlines and surface pressure (Cp).</li>
      </ul>
      <h3>Other tools</h3>
      <ul>
        <li>Drag the thin <strong>handles between the columns</strong> to give the 3D view or the results more room.</li>
        <li><strong>Run History</strong> (top right) reopens any earlier run read-only, so you can compare versions of your car.</li>
        <li><strong>Log Out</strong> when you have finished, especially on a shared computer.</li>
      </ul>
      <p class="help-tip">That is everything. Press <strong>Finish</strong> to get started.</p>
    `,
  },
];
