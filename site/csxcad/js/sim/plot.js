// Small dependency-free SVG charts for simulation results (line charts and polar cuts).
// Colours come from CSS variables so both themes work.
const NS = "http://www.w3.org/2000/svg";
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, v);
  for (const k of kids) if (k) e.append(k);
  return e;
};
const text = (x, y, s, attrs = {}) => { const t = el("text", { x, y, ...attrs }); t.textContent = s; return t; };
export const SERIES_COLORS = ["var(--plot-1)", "var(--plot-2)", "var(--plot-3)", "var(--plot-4)"];

function niceTicks(lo, hi, n = 5) {
  if (!(hi > lo)) { hi = lo + 1; }
  const raw = (hi - lo) / n, p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw);
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toPrecision(12));
  return out;
}

// series: [{x: [], y: [] (null = gap), label, color}]; hlines: [{y, label}]
export function lineChart({ series, xLabel = "", yLabel = "", hlines = [], yMin, yMax, xFmt = v => String(v), height = 190 }) {
  const W = 560, H = height, L = 46, R = 10, T = 10, B = 30;
  const xs = series.flatMap(s => s.x), ys = series.flatMap(s => s.y).filter(v => v !== null && Number.isFinite(v));
  let x0 = Math.min(...xs), x1 = Math.max(...xs);
  let y0 = yMin ?? Math.min(...ys, ...hlines.map(h => h.y)), y1 = yMax ?? Math.max(...ys, ...hlines.map(h => h.y));
  if (!(y1 > y0)) { y0 -= 1; y1 += 1; }
  const pad = (y1 - y0) * 0.06;
  if (yMin === undefined) y0 -= pad;
  if (yMax === undefined) y1 += pad;
  const X = v => L + (v - x0) / (x1 - x0 || 1) * (W - L - R), Y = v => T + (y1 - Math.min(Math.max(v, y0), y1)) / (y1 - y0) * (H - T - B);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, class: "chart", role: "img", "aria-label": yLabel });
  const grid = el("g", { class: "chart-grid" });
  for (const v of niceTicks(y0, y1)) {
    grid.append(el("line", { x1: L, x2: W - R, y1: Y(v), y2: Y(v) }), text(L - 6, Y(v) + 4, String(v), { "text-anchor": "end", class: "chart-tick" }));
  }
  for (const v of niceTicks(x0, x1, 6)) {
    grid.append(el("line", { x1: X(v), x2: X(v), y1: T, y2: H - B }), text(X(v), H - B + 14, xFmt(v), { "text-anchor": "middle", class: "chart-tick" }));
  }
  svg.append(grid);
  for (const h of hlines) {
    svg.append(el("line", { x1: L, x2: W - R, y1: Y(h.y), y2: Y(h.y), class: "chart-ref" }));
    if (h.label) svg.append(text(W - R - 2, Y(h.y) - 4, h.label, { "text-anchor": "end", class: "chart-tick" }));
  }
  series.forEach((s, k) => {
    let d = "", pen = false;
    s.x.forEach((x, i) => {
      const y = s.y[i];
      if (y === null || !Number.isFinite(y)) { pen = false; return; }
      d += `${pen ? "L" : "M"}${X(x).toFixed(1)},${Y(y).toFixed(1)}`;
      pen = true;
    });
    svg.append(el("path", { d, class: "chart-line", stroke: s.color ?? SERIES_COLORS[k % 4] }));
  });
  svg.append(text(L, H - 4, xLabel, { class: "chart-axis" }), text(4, 12, yLabel, { class: "chart-axis" }));
  return svg;
}

// Polar cut: series [{angleDeg: [], value: [] (dB), label, color}], radial range [rMin, rMax] dB
export function polarChart({ series, rMin, rMax, size = 230, label = "" }) {
  const S = size, C = S / 2, Rr = S / 2 - 22;
  const vals = series.flatMap(s => s.value).filter(v => v !== null && Number.isFinite(v));
  rMax ??= Math.ceil(Math.max(...vals) / 5) * 5;
  rMin ??= rMax - 30;
  const r = v => Math.max(0, (Math.min(v, rMax) - rMin) / (rMax - rMin)) * Rr;
  const svg = el("svg", { viewBox: `0 0 ${S} ${S}`, class: "chart polar", role: "img", "aria-label": label });
  const g = el("g", { class: "chart-grid" });
  for (let k = 0; k <= 3; k++) {
    const v = rMin + (rMax - rMin) * k / 3;
    g.append(el("circle", { cx: C, cy: C, r: r(v) || 0.5 }));
    if (k) g.append(text(C + 3, C - r(v) + 11, `${Math.round(v)}`, { class: "chart-tick" }));
  }
  for (let a = 0; a < 360; a += 30) {
    const t = a * Math.PI / 180;
    g.append(el("line", { x1: C, y1: C, x2: C + Rr * Math.sin(t), y2: C - Rr * Math.cos(t) }));
    g.append(text(C + (Rr + 11) * Math.sin(t), C - (Rr + 11) * Math.cos(t) + 4, `${a}°`, { "text-anchor": "middle", class: "chart-tick" }));
  }
  svg.append(g);
  series.forEach((s, k) => {
    let d = "";
    s.angleDeg.forEach((a, i) => {
      const v = s.value[i];
      if (v === null || !Number.isFinite(v)) return;
      const t = a * Math.PI / 180;
      d += `${d ? "L" : "M"}${(C + r(v) * Math.sin(t)).toFixed(1)},${(C - r(v) * Math.cos(t)).toFixed(1)}`;
    });
    svg.append(el("path", { d: d + "Z", class: "chart-line", stroke: s.color ?? SERIES_COLORS[k % 4] }));
  });
  if (label) svg.append(text(4, 12, label, { class: "chart-axis" }));
  return svg;
}

// Smith chart uses the complex reflection coefficient, not S11 dB alone.
// Keep missing/invalid samples as gaps and never clamp an active/nonphysical trace.
export function smithSamples(s11, z0 = 50) {
  if (!(Number.isFinite(z0) && z0 > 0)) throw Error("Invalid Smith chart reference impedance");
  return (s11?.frequency_hz ?? []).map((hz, i) => {
    let re = s11.real?.[i], im = s11.imag?.[i];
    if (!Number.isFinite(re) || !Number.isFinite(im)) {
      const db = s11.logmag_db?.[i], phase = s11.phase_deg?.[i];
      if (!Number.isFinite(db) || !Number.isFinite(phase)) return null;
      const mag = 10 ** (db / 20), rad = phase * Math.PI / 180;
      re = mag * Math.cos(rad); im = mag * Math.sin(rad);
    }
    const mag = Math.hypot(re, im);
    if (!Number.isFinite(hz) || !Number.isFinite(mag) || mag > 1 + 1e-9) return null;
    const den = (1-re)**2 + im**2;
    return { hz, re, im, mag, db: mag > 0 ? 20*Math.log10(mag) : -Infinity,
      vswr: mag < 1 ? (1+mag)/(1-mag) : Infinity,
      r: den > 1e-24 ? z0*(1-mag*mag)/den : Infinity,
      x: den > 1e-24 ? z0*2*im/den : NaN };
  });
}

export function smithChart({s11, z0 = 50, frequencyHz}) {
  const S = 320, C = 160, R = 125;
  const X = re => C + R*re, Y = im => C - R*im;
  const wrapper = document.createElement("div");
  const samples = smithSamples(s11, z0), valid = samples.filter(Boolean);
  const svg = el("svg", {viewBox: `0 0 ${S} ${S}`, class: "chart", role: "img",
    "aria-label": `Smith chart, ${z0} ohm reference. Select a frequency with the slider below.`});
  const grid = el("g", {class:"chart-grid"});
  grid.append(el("circle",{cx:C,cy:C,r:R}), el("line",{x1:X(-1),x2:X(1),y1:C,y2:C}));
  for (const r of [.2,.5,1,2,5]) {
    grid.append(el("circle",{cx:X(r/(1+r)),cy:C,r:R/(1+r)}));
    grid.append(text(X((r-1)/(r+1)),C+12,String(r),{"text-anchor":"middle",class:"chart-tick"}));
  }
  for (const x of [-5,-2,-1,-.5,-.2,.2,.5,1,2,5]) {
    const points = Array.from({length:101},(_,i)=>{
      if(i===100)return [X(1),Y(0)];
      const r=i/(100-i), d=(r+1)**2+x*x;
      return [X((r*r+x*x-1)/d),Y(2*x/d)];
    });
    grid.append(el("path",{d:points.map(([a,b],i)=>`${i?"L":"M"}${a},${b}`).join(" "),
      fill:"none",stroke:"var(--line-2)","stroke-width":1}));
    const a=(x*x-1)/(1+x*x), b=2*x/(1+x*x);
    grid.append(text(C+(R+12)*a,C-(R+12)*b+3,`${x>0?"+":""}j${x}`,
      {"text-anchor":"middle",class:"chart-tick"}));
  }
  svg.append(grid,el("circle",{cx:C,cy:C,r:R/3,class:"chart-ref",fill:"none"}),
    text(C,14,`${z0} Ω reference · normalized R / X`,{"text-anchor":"middle",class:"chart-axis"}),
    text(C,S-5,"Dashed circle: VSWR 2:1",{"text-anchor":"middle",class:"chart-axis"}));
  wrapper.append(svg);
  if(!valid.length){
    const msg=document.createElement("p");msg.className="hint";msg.textContent="No valid complex S11 samples for this chart.";wrapper.append(msg);return wrapper;
  }
  let d="",pen=false;
  for(const p of samples){
    if(!p){pen=false;continue;}
    d+=`${pen?"L":"M"}${X(p.re)},${Y(p.im)} `;pen=true;
  }
  // Only the trace and marker own touch gestures. The rest of the SVG must
  // remain scrollable inside the mobile Results sheet.
  const trace=el("path",{d,class:"chart-line",stroke:SERIES_COLORS[0],"pointer-events":"none"});
  const marker=el("circle",{r:5,fill:SERIES_COLORS[0],stroke:"var(--panel)","stroke-width":2,"pointer-events":"none"});
  const traceHit=el("path",{d,fill:"none",stroke:"transparent","stroke-width":12,
    "stroke-linecap":"round","stroke-linejoin":"round","pointer-events":"stroke","vector-effect":"non-scaling-stroke","data-smith-drag":""});
  const markerHit=el("circle",{r:10,fill:"transparent","pointer-events":"fill","data-smith-drag":""});
  for(const hit of [traceHit,markerHit]){
    hit.style.touchAction="none";
    hit.style.cursor="crosshair";
  }
  svg.append(trace,marker,traceHit,markerHit);
  const slider=document.createElement("input");
  slider.type="range";slider.min="0";slider.max=String(valid.length-1);slider.step="1";
  slider.style.width="100%";slider.setAttribute("aria-label","Smith chart frequency marker");
  const readout=document.createElement("div");readout.className="hint";readout.setAttribute("aria-live","polite");
  const fmt=(v,n=2)=>Number.isFinite(v)?v.toFixed(n):v===Infinity?"∞":v===-Infinity?"−∞":"—";
  function select(i){
    const p=valid[i];if(!p)return;
    slider.value=String(i);
    const frequency=`${fmt(p.hz/1e9,4)} GHz`;
    slider.setAttribute("aria-valuetext",frequency);
    for(const dot of [marker,markerHit]){dot.setAttribute("cx",X(p.re));dot.setAttribute("cy",Y(p.im));}
    readout.textContent=`${frequency} · Z: ${fmt(p.r)} ${p.x<0?"−":"+"} j${fmt(Math.abs(p.x))} Ω · S11: ${fmt(p.db,1)} dB · VSWR: ${fmt(p.vswr)}`;
  }
  slider.addEventListener("input",()=>select(Number(slider.value)));
  // Drag only from the hit targets; the slider is also keyboard-accessible.
  function pick(e){
    const matrix=svg.getScreenCTM();if(!matrix)return;
    const pt=svg.createSVGPoint();pt.x=e.clientX;pt.y=e.clientY;
    const local=pt.matrixTransform(matrix.inverse());
    let best=0,dist=Infinity;
    valid.forEach((p,i)=>{const dd=(X(p.re)-local.x)**2+(Y(p.im)-local.y)**2;if(dd<dist){dist=dd;best=i;}});
    select(best);
  }
  let dragId=null;
  for(const hit of [traceHit,markerHit]){
    hit.addEventListener("pointerdown",e=>{
      if(e.button!==0||dragId!==null)return;
      dragId=e.pointerId;
      hit.setPointerCapture(e.pointerId);
      pick(e);
    });
    hit.addEventListener("pointermove",e=>{if(e.pointerId===dragId)pick(e);});
    const end=e=>{if(e.pointerId===dragId)dragId=null;};
    hit.addEventListener("pointerup",end);
    hit.addEventListener("pointercancel",end);
    hit.addEventListener("lostpointercapture",end);
  }
  wrapper.append(slider,readout);
  const skipped=samples.length-valid.length;
  if(skipped){const msg=document.createElement("p");msg.className="hint";msg.textContent=`${skipped} invalid or outside-unit-circle sample(s) omitted.`;wrapper.append(msg);}
  const target=Number.isFinite(frequencyHz)?frequencyHz:valid[0].hz;
  select(valid.reduce((best,p,i)=>Math.abs(p.hz-target)<Math.abs(valid[best].hz-target)?i:best,0));
  return wrapper;
}
