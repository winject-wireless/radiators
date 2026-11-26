// three.js viewport: Z-up CAD view with orbit/pan/zoom (mouse + touch),
// tap-to-select, view presets, domain box, ports and mesh refinements.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { tessellate } from "./geometry.js";

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

const MATERIAL_COLORS = { pec: 0xd9a54a, conductive: 0xc77b4a, conducting_sheet: 0xe8884a, dielectric: 0x4fb38a };
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
  constructor(container, { onPick }) {
    this.container = container;
    this.onPick = onPick;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1e6);
    this.camera.position.set(140, -180, 120);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.screenSpacePanning = true;
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x404858, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, -1.5, 2);
    this.camera.add(sun);
    this.scene.add(this.camera);

    this.parts = new THREE.Group();
    this.overlays = new THREE.Group();
    this.scene.add(this.parts, this.overlays);
    this.axes = new THREE.AxesHelper(1);
    this.scene.add(this.axes);
    this.grid = null;
    this.options = { domain: true, ports: true, refinements: true, grid: true, xray: false };
    this.selection = null;
    this.bounds = new THREE.Box3(new THREE.Vector3(-50, -50, -50), new THREE.Vector3(50, 50, 50));

    this.raycaster = new THREE.Raycaster();
    this._installPicking();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.applyTheme();
    this.resize();
    const loop = () => { this.controls.update(); this.renderer.render(this.scene, this.camera); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  applyTheme() {
    this.scene.background = new THREE.Color(css("--viewport-bg") || "#0e1726");
    if (this.grid) this._makeGrid(this.gridSize);
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.setBottomInset(this.bottomInset || 0);
  }

  // Shift the rendered image up by half of an overlay's height (phone sheets).
  setBottomInset(px) {
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
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const quick = performance.now() - down.t < 450;
      down = null;
      if (moved > 6 || !quick) return; // it was an orbit/pan gesture
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.camera);
      this.raycaster.params.Line.threshold = this.bounds.getSize(new THREE.Vector3()).length() / 150;
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
    this.grid.material.opacity = 0.6;
    this.grid.visible = this.options.grid;
    this.scene.add(this.grid);
  }

  // model = { geometry:[resolved comps], ports, materials, domain, mesh, hidden:Set<index> }
  update(model) {
    for (const g of [this.parts, this.overlays]) {
      g.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); });
      g.clear();
    }
    const errors = [];
    const mats = new Map((model.materials || []).map(m => [m.name, m]));
    const box = new THREE.Box3();
    model.geometry.forEach((g, index) => {
      if (!g) return; // unresolved parameters; reported by the editor
      let t;
      try { t = tessellate(g); } catch (e) { errors.push({ index, message: e.message }); return; }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(t.positions, 3));
      geo.setIndex(new THREE.BufferAttribute(t.indices, 1));
      geo.computeVertexNormals();
      const m = mats.get(g.material);
      const dielectric = m?.type === "dielectric";
      const shell = /shell/.test(g.shape);
      const mat = new THREE.MeshStandardMaterial({
        color: materialColor(m), metalness: dielectric ? 0 : 0.35, roughness: dielectric ? 0.7 : 0.38,
        transparent: dielectric || shell || this.options.xray, opacity: this.options.xray ? 0.35 : dielectric ? 0.45 : shell ? 0.8 : 1,
        side: t.flat || shell || dielectric ? THREE.DoubleSide : THREE.FrontSide,
        depthWrite: !(dielectric || this.options.xray), flatShading: g.shape === "box",
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = dielectric ? 2 : 1;
      const group = new THREE.Group();
      group.add(mesh);
      if (g.shape === "box" || /hemisphere/.test(g.shape)) {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25),
          new THREE.LineBasicMaterial({ color: 0x0b1320, transparent: true, opacity: 0.45 }));
        group.add(edges);
      }
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

    for (const r of model.mesh?.refinements || []) {
      if (!nums(r?.start) || !nums(r?.stop)) continue;
      const helper = new THREE.Box3Helper(new THREE.Box3(new THREE.Vector3(...r.start), new THREE.Vector3(...r.stop)), 0x9d7bff);
      helper.visible = this.options.refinements;
      helper.userData.overlay = "refinements";
      this.overlays.add(helper);
    }

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
    const diag = box.getSize(new THREE.Vector3()).length() || 100;
    this.axes.scale.setScalar(diag * 0.18);
    this.overlays.traverse(o => { if (o.userData.scaleWithView) o.scale.setScalar(diag * 0.006); });
    const gridSize = Math.max(10, Math.ceil(diag * 1.5));
    if (!this.grid || Math.abs(gridSize - this.gridSize) / this.gridSize > 0.5) this._makeGrid(gridSize);
    this.grid.position.z = Math.min(0, box.min.z);
    this.setSelection(this.selection);
    if (first) { this._fitted = true; this.view("iso"); }
    return errors;
  }

  setOption(key, value) {
    this.options[key] = value;
    if (key === "grid" && this.grid) this.grid.visible = value;
    this.overlays.children.forEach(o => { if (o.userData.overlay === key) o.visible = value; });
  }

  setSelection(ref) {
    this.selection = ref;
    for (const group of [...this.parts.children, ...this.overlays.children]) {
      const r = group.userData.ref;
      if (!r) continue;
      const on = ref && r.kind === ref.kind && r.index === ref.index;
      group.traverse(o => {
        if (o.isMesh && o.material?.emissive) {
          o.material.emissive.set(on ? css("--select-glow") || "#2d7fd0" : 0x000000);
          o.material.emissiveIntensity = on ? 0.9 : 0;
        }
      });
      const outline = group.children.find(c => c.userData.isOutline);
      if (outline) { group.remove(outline); outline.geometry.dispose(); }
      if (on && r.kind === "geometry") {
        const mesh = group.children.find(c => c.isMesh);
        if (mesh) {
          const box = new THREE.Box3Helper(new THREE.Box3().setFromObject(mesh), new THREE.Color(css("--accent") || "#5ab8ff"));
          box.userData.isOutline = true;
          group.add(box);
        }
      }
    }
  }

  view(name) {
    const target = (this.bounds.isEmpty() ? new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)) : this.bounds);
    const c = target.getCenter(new THREE.Vector3());
    const r = Math.max(target.getSize(new THREE.Vector3()).length() / 2, 1);
    const dist = r / Math.sin((this.camera.fov * Math.PI / 180) / 2) * (this.camera.aspect < 1 ? 1.25 / this.camera.aspect ** 0.5 : 1.05);
    const dirs = {
      iso: [1, -1.25, 0.9], top: [0, -0.0001, 1], bottom: [0, 0.0001, -1], front: [0, -1, 0],
      back: [0, 1, 0], right: [1, 0, 0], left: [-1, 0, 0],
    };
    const d = new THREE.Vector3(...(dirs[name] || dirs.iso)).normalize();
    this.camera.position.copy(c.clone().add(d.multiplyScalar(dist)));
    this.camera.near = dist / 1000;
    this.camera.far = dist * 100;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(c);
    this.controls.update();
  }

  screenshot() {
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL("image/png");
  }
}
