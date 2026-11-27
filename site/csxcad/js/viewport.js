// three.js viewport: Z-up CAD view with orbit/pan/zoom (mouse + touch),
// tap-to-select, view presets, domain box, ports and mesh refinements.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import { tessellate } from "./geometry.js";
import { planeSegments } from "./sim/radiation.js";

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

// Metals are lit by the environment map, so their base colors are close to real copper / brass tones.
const MATERIAL_COLORS = { pec: 0xd8a368, conductive: 0xc9825f, conducting_sheet: 0xe0a070, dielectric: 0x3fa882 };
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function hashHue(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}
export function materialColor(m) {
  const base = new THREE.Color(MATERIAL_COLORS[m?.type] ?? 0x8aa0b8);
  const hsl = {}; base.getHSL(hsl);
  // Offset hue slightly per material name so two metals are distinguishable.
  const shift = ((hashHue(m?.name ?? "") % 9) - 4) * 0.012;
  return new THREE.Color().setHSL((hsl.h + shift + 1) % 1, hsl.s, hsl.l);
}

export class Viewport {
  constructor(container, { onPick, onHandle, onHandleMove, onHandleDrag, onScalarMove }) {
    this.container = container;
    this.onPick = onPick;
    this.onHandle = onHandle || (() => {});
    this.onHandleMove = onHandleMove || (() => {});
    this.onHandleDrag = onHandleDrag || (() => {});
    this.onScalarMove = onScalarMove || (() => "");
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0x000000, 0); // the CSS gradient behind the canvas is the background
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.perspective = new THREE.PerspectiveCamera(40, 1, 0.1, 1e6);
    this.orthographic = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1e6);
    this.camera = this.perspective;
    this.camera.position.set(140, -180, 120);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

    // Soft image-based fill plus a key light; materials are matte, so this only shapes form.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(this.renderer), 0.04).texture;
    pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404858, 0.9));
    this.keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
    this.keyLight.position.set(1, -1.5, 2);
    this.camera.add(this.keyLight);
    this.scene.add(this.camera);

    this.parts = new THREE.Group();
    this.overlays = new THREE.Group();
    this.radiation = new THREE.Group();
    this.sections = new THREE.Group();
    this.scene.add(this.parts, this.overlays, this.radiation, this.sections);
    this.axes = new THREE.AxesHelper(1);
    this.scene.add(this.axes);
    this.grid = null;
    this.options = { domain: false, ports: true, grid: true, xray: false };
    this.selection = null;
    this.bounds = new THREE.Box3(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));

    // Position handles of the selected object, plus a 3-axis translate gizmo on the active one.
    this.handles = new THREE.Group();
    this.scene.add(this.handles);
    this.handleKey = null;
    this.gizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.gizmo.setMode("translate");
    this.gizmo.setSpace("world");
    this.gizmo.size = matchMedia("(pointer: coarse)").matches ? 1.35 : 1;
    this.gizmo.addEventListener("mouseDown", () => { this._gizmoGrab = true; });
    this.gizmo.addEventListener("dragging-changed", e => {
      this.controls.enabled = !e.value;
      this.onHandleDrag(e.value, this.handleKey);
    });
    this.gizmo.addEventListener("objectChange", () => {
      const o = this.gizmo.object;
      if (o && this.gizmo.dragging) this.onHandleMove(o.userData.handleKey, o.position.toArray());
    });
    this.scene.add(this.gizmo);
    this.label = document.createElement("div");
    this.label.className = "handle-label";
    this.label.hidden = true;
    container.appendChild(this.label);
    this.guide = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0xffb020, transparent: true, opacity: 0.7, depthTest: false }));
    this.guide.renderOrder = 19;
    this.guide.visible = false;
    this.scene.add(this.guide);
    this._installScalarDrag();

    this.raycaster = new THREE.Raycaster();
    this._installPicking();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.applyTheme();
    this.resize();
    // Render on demand: only when the camera moves, a focus animation runs, or something
    // changed (any public method calls markDirty). Saves CPU/battery, e.g. during simulations.
    this._dirty = true;
    this.controls.addEventListener("change", () => { this._dirty = true; });
    this.gizmo.addEventListener("change", () => { this._dirty = true; });
    const loop = now => {
      const focusing = !!this._focus;
      this._stepFocus(now);
      const moved = this.controls.update();
      if (this._dirty || moved || focusing || this._scalar || this.gizmo.dragging) {
        this._dirty = false;
        // Handles keep a constant on-screen size.
        const touch = matchMedia("(pointer: coarse)").matches;
        this._updateClipPlanes();
        this.camera.updateMatrixWorld();
        const cameraPoint=new THREE.Vector3();
        const height=Math.max(1,this.renderer.domElement.clientHeight);
        const projectionScale=Math.abs(this.camera.projectionMatrix.elements[5]);
        for (const hnd of this.handles.children) {
          if(hnd.userData.handleKey==="result-probe"){
            // In an orthographic view the pixel scale is independent of depth.
            cameraPoint.copy(hnd.position).applyMatrix4(this.camera.matrixWorldInverse);
            const depth=this.camera.isOrthographicCamera ? 1 : Math.max(this.camera.near,-cameraPoint.z);
            const px=(touch?7:5.5)*(hnd===this._hover?1.15:1);
            hnd.scale.setScalar(Math.max(1e-6,px*2*depth/(height*projectionScale)));
          } else {
            const distance = this.camera.isOrthographicCamera
              ? 1 / (projectionScale * this._tanHalfFov())
              : hnd.position.distanceTo(this.camera.position);
            hnd.scale.setScalar(Math.max(1e-6, distance * 0.011 * (touch ? 1.5 : 1) * (hnd === this._hover ? 1.35 : 1)));
          }
        }
        this.renderer.render(this.scene, this.camera);
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  markDirty() { this._dirty = true; }

  // Fit sets the pose, not a permanent near plane. At close feed inspection
  // distances the original fit-dependent near plane can cut through conductors.
  _updateClipPlanes() {
    const distance=Math.max(1e-4,this.camera.position.distanceTo(this.controls.target));
    const center=this.bounds.getCenter(new THREE.Vector3());
    const diagonal=Math.max(1,this.bounds.getSize(new THREE.Vector3()).length());
    const near=Math.max(1e-5,Math.min(distance/1000,diagonal/2000));
    let far=Math.max(10,distance*4,this.camera.position.distanceTo(center)+diagonal*4);
    if(this.domainBox&&this.options.domain){
      far=Math.max(far,this.camera.position.distanceTo(this.domainBox.getCenter(new THREE.Vector3()))+this.domainBox.getSize(new THREE.Vector3()).length());
    }
    if(Math.abs(this.camera.near-near)>near*0.01||Math.abs(this.camera.far-far)>far*0.01){
      this.camera.near=near;this.camera.far=far;
      this.camera.updateProjectionMatrix();
    }
  }

  applyTheme() {
    this._dirty = true;
    this.scene.background = null;
    if (this.grid) this._makeGrid(this.gridSize);
  }

  resize() {
    this._dirty = true;
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.perspective.aspect = w / h;
    this.orthographic.left = -w / h;
    this.orthographic.right = w / h;
    this.setBottomInset(this.bottomInset || 0);
  }

  // Shift the rendered image up by half of an overlay's height (phone sheets).
  setBottomInset(px) {
    this._dirty = true;
    this.bottomInset = px;
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    if (px > 0) this.camera.setViewOffset(w, h, 0, Math.min(px, h * 0.9) / 2, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  _installPicking() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener("pointerdown", e => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    el.addEventListener("pointerup", e => {
      if (!down) return;
      if (this._gizmoGrab) { this._gizmoGrab = false; down = null; return; }
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 450;
      down = null;
      if (moved > 6 || !quick) return; // it was an orbit/pan gesture
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.camera);
      this.raycaster.params.Line.threshold = this.bounds.getSize(new THREE.Vector3()).length() / 150;
      const hh = this.raycaster.intersectObjects(this.handles.children, false).find(x => x.object.userData.kind !== "scalar");
      if (hh) { this.onHandle(hh.object.userData.handleKey); return; }
      const targets = [...this.parts.children, ...this.overlays.children.filter(o => o.userData.ref)];
      const hit = this.raycaster.intersectObjects(targets, true).find(h => {
        let o = h.object;
        while (o && !o.userData.ref) o = o.parent;
        return o && o.visible;
      });
      let o = hit?.object;
      while (o && !o.userData.ref) o = o.parent;
      this.onPick(o ? o.userData.ref : null);
    });
  }

  _makeGrid(size) {
    if (this.grid) { this.scene.remove(this.grid); this.grid.geometry.dispose(); }
    this.gridSize = size;
    const step = Math.pow(10, Math.floor(Math.log10(size / 4)));
    const divisions = Math.min(400, Math.round(size / step));
    this.grid = new THREE.GridHelper(divisions * step, divisions, new THREE.Color(css("--grid-major") || "#3a5068"),
      new THREE.Color(css("--grid-minor") || "#22344a"));
    this.grid.rotation.x = Math.PI / 2;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.45;
    this.grid.visible = this.options.grid;
    this.scene.add(this.grid);
  }

  // model = { geometry:[resolved comps], ports, materials, domain, mesh, hidden:Set<index> }
  update(model) {
    this._dirty = true;
    for (const g of [this.parts, this.overlays]) {
      g.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); });
      g.clear();
    }
    const errors = [];
    const mats = new Map((model.materials || []).map(m => [m.name, m]));
    const box = new THREE.Box3();
    // A script instance arrives as { __parts: [primitive…] }: all its pieces share one
    // group (one ref), so clicking any piece selects the whole object.
    model.geometry.forEach((g, index) => {
      if (!g) return; // unresolved parameters or a script still running; reported by the editor
      const group = new THREE.Group();
      for (const part of g.__parts || [g]) {
        let t;
        try { t = tessellate(part); } catch (e) { errors.push({ index, message: (g.__parts ? `${part.name}: ` : "") + e.message }); continue; }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(t.positions, 3));
        geo.setIndex(new THREE.BufferAttribute(t.indices, 1));
        geo.computeVertexNormals();
        const m = mats.get(part.material);
        const dielectric = m?.type === "dielectric";
        // PEC and conductive shells are closed material volumes, not
        // translucent skins. Draw their inner and outer surfaces using their
        // actual winding, just like a solid conductor. Only sheets need both sides.
        const mat = new THREE.MeshStandardMaterial({
          // Matte, CAD-style shading: no mirror reflections, just soft form.
          color: materialColor(m), metalness: dielectric ? 0 : 0.15, roughness: 0.85, envMapIntensity: 0.6,
          transparent: dielectric || this.options.xray, opacity: this.options.xray ? 0.35 : dielectric ? 0.45 : 1,
          side: t.flat || dielectric ? THREE.DoubleSide : THREE.FrontSide,
          depthWrite: !(dielectric || this.options.xray), flatShading: part.shape === "box",
          polygonOffset: t.flat, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        });
        mat.userData.base = { transparent: mat.transparent, opacity: mat.opacity, depthWrite: mat.depthWrite };
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = dielectric ? 2 : 1;
        group.add(mesh);
      }
      if (!group.children.length) return;
      group.userData.ref = { kind: "geometry", index };
      group.visible = !model.hidden?.has(index);
      this.parts.add(group);
      if (group.visible) box.expandByObject(group);
    });

    const nums = v => Array.isArray(v) && v.length === 3 && v.every(x => typeof x === "number" && Number.isFinite(x));
    if (model.domain && nums(model.domain.start) && nums(model.domain.stop)) {
      const a = new THREE.Vector3(...model.domain.start), b = new THREE.Vector3(...model.domain.stop);
      const helper = new THREE.Box3Helper(new THREE.Box3(a.clone().min(b), a.clone().max(b)), new THREE.Color(css("--domain") || "#6f8fb0"));
      helper.material.transparent = true;
      helper.material.opacity = 0.7;
      helper.visible = this.options.domain;
      helper.userData.overlay = "domain";
      this.overlays.add(helper);
      this.domainBox = new THREE.Box3(a.clone().min(b), a.clone().max(b));
    } else this.domainBox = null;

    (model.mesh?.refinements||[]).forEach((r,index)=>{
      if (!nums(r?.start)||!nums(r?.stop))return;
      const a=new THREE.Vector3(...r.start),b=new THREE.Vector3(...r.stop);
      const helper=new THREE.Box3Helper(new THREE.Box3(a.clone().min(b),a.clone().max(b)),0x9d7bff);
      helper.userData.overlay="domain";
      helper.userData.ref={kind:"refinement",index};
      this.overlays.add(helper);
    });

    (model.ports || []).forEach((p, index) => {
      if (!p || !Array.isArray(p.start) || !Array.isArray(p.stop) || [...p.start, ...p.stop].some(v => typeof v !== "number")) return;
      const a = new THREE.Vector3(...p.start), b = new THREE.Vector3(...p.stop);
      const group = new THREE.Group();
      const color = p.excite ? 0xff4d5e : 0xff9aa6;
      const lo = a.clone().min(b), hi = a.clone().max(b);
      const size = hi.clone().sub(lo);
      if (p.type === "lumped" || p.type === "lumped_port") {
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]),
          new THREE.LineBasicMaterial({ color, depthTest: false }));
        line.renderOrder = 5;
        group.add(line);
        const len = a.distanceTo(b) || 1;
        const cone = new THREE.Mesh(new THREE.ConeGeometry(len * 0.18, len * 0.4, 12),
          new THREE.MeshBasicMaterial({ color, depthTest: false }));
        cone.renderOrder = 5;
        const d = b.clone().sub(a).normalize();
        if (d.lengthSq()) cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
        cone.position.copy(a.clone().lerp(b, 0.6));
        group.add(cone);
      }
      if (size.x || size.y || size.z) {
        const fill = new THREE.Mesh(new THREE.BoxGeometry(Math.max(size.x, 0.05), Math.max(size.y, 0.05), Math.max(size.z, 0.05)),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: p.type === "lumped" ? 0.12 : 0.3, depthWrite: false }));
        fill.position.copy(lo.clone().add(hi).multiplyScalar(0.5));
        group.add(fill);
      }
      const dot = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color, depthTest: false }));
      dot.renderOrder = 6;
      dot.position.copy(a);
      dot.userData.scaleWithView = true;
      group.add(dot);
      group.userData.ref = { kind: "port", index };
      group.userData.overlay = "ports";
      group.visible = this.options.ports;
      this.overlays.add(group);
      box.expandByPoint(a).expandByPoint(b);
    });

    if (box.isEmpty()) box.copy(this.domainBox || new THREE.Box3(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50)));
    const first = !this._fitted;
    this.bounds = box;
    const pattern = this._radiationRecord;
    this._radiationRecord = undefined;
    this.setRadiation(pattern);
    const diag = box.getSize(new THREE.Vector3()).length() || 100;
    this.axes.scale.setScalar(diag * 0.18);
    this.overlays.traverse(o => { if (o.userData.scaleWithView) o.scale.setScalar(diag * 0.006); });
    const gridSize = Math.max(10, Math.ceil(diag * 1.5));
    if (!this.grid || Math.abs(gridSize - this.gridSize) / this.gridSize > 0.5) this._makeGrid(gridSize);
    // The construction grid represents the global XY plane, not the bottom
    // of the model's bounding box. Negative-Z geometry must not move it.
    this.grid.position.set(0, 0, 0);
    this.setSelection(this.selection);
    if (first) { this._fitted = true; this.view("perspective"); }
    return errors;
  }

  // Directivity surface uses normalized E-field amplitude, not power or a physical radius.
  // The peak display radius surrounds the model and uses the same angular convention as NF2FF.
  setRadiation(record) {
    if (record === this._radiationRecord) return;
    this._radiationRecord = record;
    this._dirty = true;
    for (const o of this.radiation.children) {
      o.geometry.dispose();
      o.material.dispose();
    }
    this.radiation.clear();
    this._sectionKey = null;
    this._clearSections();
    if (!record?.radiation_valid) return;
    const { theta_deg: theta, phi_deg: phi, directivity_dbi: db, max_directivity_dbi: peak } = record;
    if (!theta?.length || !phi?.length || !Number.isFinite(peak)) return;
    const radius = 1.65 * Math.max(10, ...this.bounds.min.toArray().map(Math.abs), ...this.bounds.max.toArray().map(Math.abs));
    this.radiationRadius = radius;
    const pos = [], colors = [], indices = [];
    const color = new THREE.Color();
    const n = phi.length;
    for (let i = 0; i < theta.length; i++) {
      const t = theta[i] * Math.PI / 180;
      for (let j = 0; j < n; j++) {
        const f = phi[j] * Math.PI / 180;
        const level = db[i]?.[j];
        const r = Number.isFinite(level) ? radius * Math.min(1, 10 ** ((level - peak) / 20)) : 0;
        pos.push(r * Math.sin(t) * Math.cos(f), r * Math.sin(t) * Math.sin(f), r * Math.cos(t));
        color.setHSL(0.67 * (1 - Math.max(0, Math.min(1, (Number.isFinite(level) ? level - peak + 30 : 0) / 30))), 0.85, 0.55);
        colors.push(color.r, color.g, color.b);
        if (i + 1 < theta.length) {
          const a = i * n + j, b = i * n + (j + 1) % n;
          indices.push(a, b, a + n, b, b + n, a + n);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();
    this.radiation.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false,
    })));
  }

  _clearSections() {
    for (const child of this.sections.children) {
      child.geometry.dispose();
      child.material.dispose();
    }
    this.sections.clear();
  }

  setSections(planes, point = [0, 0, 0]) {
    const key = JSON.stringify([planes, point]);
    if (key === this._sectionKey) return;
    this._sectionKey = key;
    this._clearSections();
    this._dirty = true;
    const surface = this.radiation.children[0]?.geometry;
    if (!surface) return;
    const positions = surface.attributes.position.array, indices = surface.index.array;
    const radius = this.radiationRadius;
    for (const [name, axis, color] of [["YZ",0,0xff6978],["XZ",1,0x53da9a],["XY",2,0x61adff]]) {
      if (!planes.includes(name)) continue;
      const offset = point[axis];
      const coords = planeSegments(positions, indices, axis, offset, Math.max(1e-6, radius * 1e-7));
      const square = new THREE.PlaneGeometry(radius * 2.1, radius * 2.1);
      if (axis === 0) square.rotateY(Math.PI / 2);
      if (axis === 1) square.rotateX(Math.PI / 2);
      const plane = new THREE.Mesh(square, new THREE.MeshBasicMaterial({
        color, transparent: true, opacity: 0.055, depthWrite: false, side: THREE.DoubleSide,
      }));
      plane.position.setComponent(axis, offset);
      plane.userData.section = name;
      this.sections.add(plane);
      if (!coords.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(coords, 3));
      const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 }));
      line.renderOrder = 15;
      line.userData.section = name;
      this.sections.add(line);
    }
  }

  setOption(key, value) {
    this._dirty = true;
    this.options[key] = value;
    if (key === "grid" && this.grid) this.grid.visible = value;
    this.overlays.children.forEach(o => { if (o.userData.overlay === key) o.visible = value || (o.userData.ref?.kind==="refinement"&&this.selection?.kind==="refinement"&&o.userData.ref.index===this.selection.index); });
  }

  setSelection(ref) {
    this._dirty = true;
    this.selection = ref;
    const focused = ref && (ref.kind === "geometry" || ref.kind === "port");
    for (const group of this.parts.children) {
      const r = group.userData.ref;
      const ghost = focused && !(r.kind === ref.kind && r.index === ref.index);
      group.traverse(o => {
        const base = o.material?.userData?.base;
        if (!base) return;
        o.material.transparent = ghost || base.transparent;
        o.material.opacity = ghost ? Math.min(base.opacity, o.isMesh ? 0.14 : 0.06) : base.opacity;
        o.material.depthWrite = ghost ? false : base.depthWrite;
        o.material.needsUpdate = true;
      });
    }
    for (const group of [...this.parts.children, ...this.overlays.children]) {
      const r = group.userData.ref;
      if (!r) continue;
      const on = ref && r.kind === ref.kind && r.index === ref.index;
      if(r.kind==="refinement"){
        group.visible=!!on||this.options.domain;
        group.material.color.set(on?0xcbb6ff:0x9d7bff);
      }
      group.traverse(o => {
        if (o.isMesh && o.material?.emissive) {
          // Others are ghosted, so the selection only needs a faint tint to keep its real colour.
          o.material.emissive.set(on ? css("--select-glow") || "#2d7fd0" : 0x000000);
          o.material.emissiveIntensity = on ? 0.14 : 0;
        }
      });
    }
  }

  // Smoothly re-centre on the selected object and bring it to a comfortable size.
  focus(ref) {
    const group = [...this.parts.children, ...this.overlays.children].find(g =>
      g.userData.ref && ref && g.userData.ref.kind === ref.kind && g.userData.ref.index === ref.index);
    if (!group) return;
    const box = new THREE.Box3().setFromObject(group);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, this.bounds.getSize(new THREE.Vector3()).length() / 40, 0.5);
    const h = Math.max(1, this.container.clientHeight);
    const covered = h / Math.max(h * 0.3, h - Math.min(this.bottomInset || 0, h * 0.7)); // part hidden by a phone sheet
    const dist = r / Math.sin((this.perspective.fov * Math.PI / 180) / 2) * 1.8 * covered * (this.perspective.aspect < 1 ? 1 / this.perspective.aspect ** 0.5 : 1);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this._focus = { t0: performance.now(), fromT: this.controls.target.clone(), toT: c,
      fromZoom: this.camera.zoom, toZoom: 1 / (dist * this._tanHalfFov()),
      fromP: this.camera.position.clone(), toP: c.clone().add(dir.multiplyScalar(dist)) };
  }
  _stepFocus(now) {
    const f = this._focus;
    if (!f) return;
    const k = Math.min(1, (now - f.t0) / 380), e = 1 - (1 - k) ** 3;
    this.controls.target.lerpVectors(f.fromT, f.toT, e);
    this.camera.position.lerpVectors(f.fromP, f.toP, e);
    if (this.camera.isOrthographicCamera) {
      this.camera.zoom = THREE.MathUtils.lerp(f.fromZoom, f.toZoom, e);
      this.camera.updateProjectionMatrix();
    }
    if (k >= 1) this._focus = null;
  }

  // handles: point {key, kind:"point", pos, axes:[bool×3]} → 3-axis gizmo when active;
  //          scalar {key, kind:"scalar", base, dir, dist, enabled} → slides along base + dir·t;
  //          action {key, kind:"action", pos} → tap only (e.g. insert a wire vertex).
  setHandles(list, activeKey, snap) {
    this._dirty = true;
    this.snap = snap || 0;
    const keep = new Map(this.handles.children.map(o => [o.userData.handleKey, o]));
    const want = new Set();
    const accent = new THREE.Color(css("--accent") || "#5ab8ff");
    const geoms = this._handleGeoms ??= {
      point: new THREE.SphereGeometry(1, 16, 12), scalar: new THREE.OctahedronGeometry(1.25), action: new THREE.SphereGeometry(0.75, 12, 8),
    };
    for (const hd of list) {
      const kind = hd.kind || "point";
      want.add(hd.key);
      let o = keep.get(hd.key);
      if (o && o.userData.kind !== kind) { this.handles.remove(o); o.material.dispose(); o = null; }
      if (!o) {
        o = new THREE.Mesh(geoms[kind], new THREE.MeshBasicMaterial({ depthTest: false, transparent: true }));
        o.renderOrder = 20;
        o.userData.handleKey = hd.key;
        o.userData.kind = kind;
        this.handles.add(o);
      }
      const dragging = (this.gizmo.dragging && this.gizmo.object === o) || this._scalar?.object === o;
      if (kind === "scalar") {
        if (!dragging) {
          o.userData.base = new THREE.Vector3(...hd.base);
          o.userData.dir = new THREE.Vector3(...hd.dir).normalize();
        }
        o.userData.enabled = hd.enabled;
        if (!dragging) o.position.copy(o.userData.base).addScaledVector(o.userData.dir, hd.dist);
        o.material.color.set(hd.enabled ? 0xffb020 : 0x7d8796);
        o.material.opacity = hd.enabled ? 1 : 0.6;
      } else {
        if (!dragging) o.position.set(...hd.pos);
        const active = hd.key === activeKey;
        o.material.color.set(hd.key === "result-probe" ? (active ? 0xffb020 : 0xffdf73) : kind === "action" ? 0x5fd08a : active ? accent : 0xffffff);
        o.material.opacity = kind === "action" ? 0.9 : active ? 1 : 0.85;
        o.userData.axes = hd.axes || [false, false, false];
        o.userData.size = 1;
        o.userData.snap = hd.snap;
      }
    }
    for (const [k, o] of keep) if (!want.has(k) && this._scalar?.object !== o) { this.handles.remove(o); o.material.dispose(); }
    const target = this.handles.children.find(o => o.userData.handleKey === activeKey && o.userData.kind === "point");
    this.handleKey = target ? activeKey : null;
    if (target && target.userData.axes.some(Boolean)) {
      if (this.gizmo.object !== target) this.gizmo.attach(target);
      [this.gizmo.showX, this.gizmo.showY, this.gizmo.showZ] = target.userData.axes;
      this.gizmo.setTranslationSnap(target.userData.snap || snap || null); // a script's `step` wins
    } else if (this.gizmo.object) this.gizmo.detach();
  }

  _rayAt(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray;
  }
  _hitScalar(e) {
    this._rayAt(e);
    return this.raycaster.intersectObjects(this.handles.children, false)
      .map(x => x.object).find(o => o.userData.kind === "scalar" ? o.userData.enabled : o.userData.kind === "action") || null;
  }
  // Scalar handles slide along a line; runs in the capture phase so orbit/gizmo never see the grab.
  _installScalarDrag() {
    const el = this.container;
    el.addEventListener("pointerdown", e => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const o = this._hitScalar(e);
      if (!o || o.userData.kind !== "scalar") return;
      e.stopPropagation();
      e.preventDefault();
      this.controls.enabled = false;
      this._scalar = { object: o, id: e.pointerId };
      this.onHandleDrag(true, o.userData.handleKey);
      const move = ev => {
        if (ev.pointerId !== this._scalar?.id) return;
        const ray = this._rayAt(ev);
        const B = o.userData.base, D = o.userData.dir, V = ray.direction, w0 = B.clone().sub(ray.origin);
        const b = D.dot(V), denom = 1 - b * b;
        if (denom < 1e-6) return; // looking straight down the handle's line
        let t = (b * V.dot(w0) - D.dot(w0)) / denom;
        if (this.snap) t = Math.round(t / this.snap) * this.snap;
        const text = this.onScalarMove(o.userData.handleKey, t);
        if (text === null) return; // rejected (out of range)
        o.position.copy(B).addScaledVector(D, t);
        this._dirty = true;
        const span = Math.max(Math.abs(t), this.bounds.getSize(new THREE.Vector3()).length() * 0.05);
        this.guide.geometry.setFromPoints([B.clone().addScaledVector(D, -span * 0.15), B.clone().addScaledVector(D, t + Math.sign(t || 1) * span * 0.3)]);
        this.guide.visible = true;
        const r = this.container.getBoundingClientRect();
        this.label.textContent = text;
        this.label.style.left = `${ev.clientX - r.left + 14}px`;
        this.label.style.top = `${ev.clientY - r.top - 34}px`;
        this.label.hidden = false;
      };
      const up = ev => {
        if (ev.pointerId !== this._scalar?.id) return;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", up);
        this._scalar = null;
        this.controls.enabled = true;
        this.guide.visible = false;
        this.label.hidden = true;
        this.onHandleDrag(false, o.userData.handleKey);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", up);
    }, { capture: true });
    // Hover feedback (desktop): enlarge the handle under the pointer.
    el.addEventListener("pointermove", e => {
      if (this._scalar || e.pointerType !== "mouse" || e.buttons) return;
      this._rayAt(e);
      const o = this.raycaster.intersectObjects(this.handles.children, false)[0]?.object || null;
      if (this._hover !== o) this._dirty = true;
      this._hover = o;
      el.style.cursor = o ? (o.userData.kind === "scalar" ? (o.userData.enabled ? "grab" : "not-allowed") : "pointer") : "";
    });
  }

  _tanHalfFov() {
    return Math.tan(THREE.MathUtils.degToRad(this.perspective.fov / 2));
  }

  view(name) {
    this._dirty = true;
    this._focus = null;
    // Finish any pending damped orbit or pan before applying the exact preset pose.
    const damping = this.controls.enableDamping;
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = damping;
    const target = (this.bounds.isEmpty() ? new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)) : this.bounds.clone());
    if (this.radiation.children.length) target.union(new THREE.Box3().setFromObject(this.radiation));
    const c = target.getCenter(new THREE.Vector3());
    const r = Math.max(target.getSize(new THREE.Vector3()).length() / 2, 1);
    const dist = r / Math.sin((this.perspective.fov * Math.PI / 180) / 2) * (this.perspective.aspect < 1 ? 1.25 / this.perspective.aspect ** 0.5 : 1.05);
    const camera = name === "iso" ? this.orthographic : name === "perspective" ? this.perspective : this.camera;
    if (camera !== this.camera) {
      this.scene.remove(this.camera);
      this.camera = camera;
      this.scene.add(camera);
      camera.add(this.keyLight);
      this.controls.object = camera;
      this.gizmo.camera = camera;
      this.resize();
    }
    if (camera.isOrthographicCamera) {
      const aspect = this.perspective.aspect;
      const halfHeight = 1.05 * r / Math.min(1, aspect);
      camera.zoom = 1 / halfHeight;
    } else {
      camera.zoom = 1;
    }
    camera.up.set(0, 0, 1);
    camera.updateProjectionMatrix();
    const dirs = {
      perspective: [1, -1.25, 0.9], iso: [1, -1, 1], top: [0, -0.0001, 1], bottom: [0, 0.0001, -1], front: [0, -1, 0],
      back: [0, 1, 0], right: [1, 0, 0], left: [-1, 0, 0],
    };
    const d = new THREE.Vector3(...(dirs[name] || (camera.isOrthographicCamera ? dirs.iso : dirs.perspective))).normalize();
    this.camera.position.copy(c.clone().add(d.multiplyScalar(dist)));
    this.controls.target.copy(c);
    this._updateClipPlanes();
    this.controls.update();
  }

  screenshot() {
    // Composite onto the themed background; the live canvas is transparent.
    this.scene.background = new THREE.Color(css("--viewport-bg") || "#0e1726");
    this.renderer.render(this.scene, this.camera);
    const url = this.renderer.domElement.toDataURL("image/png");
    this.scene.background = null;
    return url;
  }
}
