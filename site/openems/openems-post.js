// Post-processing helpers for openEMS results, ported from the openEMS Python
// package (openEMS/utilities.py, openEMS/ports.py, openEMS/nf2ff.py), so the
// browser gives the numbers radiators' simulate_v2.py gives.

// A port probe file (port_ut_1, port_it_1, ...) -> {t, v} (Float64Array each)
export function parseProbe(text) {
  if (typeof text !== 'string') text = new TextDecoder().decode(text);
  const t = [];
  const v = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s || s[0] === '%') continue;
    const cols = s.split(/\s+/);
    t.push(Number(cols[0]));
    v.push(Number(cols[1]));
  }
  return { t: Float64Array.from(t), v: Float64Array.from(v) };
}

// Single-sided DFT of a pulse, as utilities.DFT_time2freq(signal_type='pulse')
export function dft(t, v, freqs) {
  const re = new Float64Array(freqs.length);
  const im = new Float64Array(freqs.length);
  const dt = t[1] - t[0];
  for (let k = 0; k < freqs.length; k++) {
    const w = -2 * Math.PI * freqs[k];
    let sr = 0;
    let si = 0;
    for (let n = 0; n < t.length; n++) {
      const a = w * t[n];
      sr += v[n] * Math.cos(a);
      si += v[n] * Math.sin(a);
    }
    re[k] = 2 * sr * dt;
    im[k] = 2 * si * dt;
  }
  return { re, im };
}

// Frequencies of a radiators "s11" sweep list ({start, step, end} or {start, stop, points})
export function sweepFrequencies(sweeps) {
  const out = [];
  for (const s of sweeps) {
    if (s.step) {
      const n = Math.round((s.end - s.start) / s.step);
      for (let i = 0; i <= n; i++) out.push(s.start + i * s.step);
    } else {
      const n = s.points;
      const end = s.end ?? s.stop;
      for (let i = 0; i < n; i++) out.push(n === 1 ? s.start : s.start + (i * (end - s.start)) / (n - 1));
    }
  }
  return out;
}

const cmul = (ar, ai, br, bi) => [ar * br - ai * bi, ar * bi + ai * br];
const cdiv = (ar, ai, br, bi) => {
  const d = br * br + bi * bi;
  return [(ar * br + ai * bi) / d, (ai * br - ar * bi) / d];
};

// A lumped (or any scalar Z_ref) port, as ports.Port.CalcPort:
// ut/it are probe file contents (text or bytes), freqs in Hz.
// Returns per frequency: s11 {re, im, db, phaseDeg}, vswr, zin {re, im},
// uf/if {tot, inc, ref}, and pInc / pRef / pAcc in W.
export function lumpedPort(ut, it, freqs, zRef) {
  const u = parseProbe(ut);
  const i = parseProbe(it);
  const U = dft(u.t, u.v, freqs);
  const I = dft(i.t, i.v, freqs);
  const n = freqs.length;
  const out = {
    frequencyHz: Float64Array.from(freqs),
    s11: { re: new Float64Array(n), im: new Float64Array(n), db: new Float64Array(n), phaseDeg: new Float64Array(n) },
    vswr: new Float64Array(n),
    zin: { re: new Float64Array(n), im: new Float64Array(n) },
    pInc: new Float64Array(n),
    pRef: new Float64Array(n),
    pAcc: new Float64Array(n),
    ufTot: U,
    ifTot: I,
  };
  for (let k = 0; k < n; k++) {
    const [ur, ui, ir, ii] = [U.re[k], U.im[k], I.re[k], I.im[k]];
    const incR = 0.5 * (ur + zRef * ir);
    const incI = 0.5 * (ui + zRef * ii);
    const refR = ur - incR;
    const refI = ui - incI;
    const [gr, gi] = cdiv(refR, refI, incR, incI);
    const mag = Math.hypot(gr, gi);
    out.s11.re[k] = gr;
    out.s11.im[k] = gi;
    out.s11.db[k] = 20 * Math.log10(Math.max(mag, 1e-16));
    out.s11.phaseDeg[k] = (Math.atan2(gi, gr) * 180) / Math.PI;
    out.vswr[k] = mag < 1 ? (1 + mag) / Math.max(1 - mag, 1e-15) : Infinity;
    const [zr, zi] = cdiv(ur, ui, ir, ii);
    out.zin.re[k] = zr;
    out.zin.im[k] = zi;
    // P = 0.5 * Re(u * conj(i)); incident/reflected current = u_inc/Z_ref, -u_ref/Z_ref
    out.pAcc[k] = 0.5 * cmul(ur, ui, ir, -ii)[0];
    out.pInc[k] = (0.5 * (incR * incR + incI * incI)) / zRef;
    out.pRef[k] = (0.5 * (refR * refR + refI * refI)) / zRef;
  }
  return out;
}

const fmt = (x) => Number(x).toPrecision(17).replace(/\.?0+(e|$)/, '$1');

// The nf2ff input XML (what nf2ff::AnalyseXMLNode reads). Angles in degrees.
// box: {e_file, h_file, mirror[6], start[3], stop[3]} (openEMS CreateNF2FFBox; start/stop
// in drawing units, scaled by deltaUnit for the mirror positions).
export function nf2ffXml({ freqs, thetaDeg, phiDeg, outfile, box, center = [0, 0, 0], radius = 1, deltaUnit = 1e-3, numThreads, verbose = 0 }) {
  const rad = (a) => Array.from(a, (d) => fmt((d * Math.PI) / 180)).join(',');
  const mirrors = [];
  (box.mirror || []).forEach((m, k) => {
    if (!m) return;
    const dir = k >> 1;
    const pos = ((k & 1) ? box.stop[dir] : box.start[dir]) * deltaUnit;
    mirrors.push(`<Mirror Dir="${dir}" Type="${m === 1 || m === 'PEC' ? 'PEC' : 'PMC'}" Pos="${fmt(pos)}"/>`);
  });
  const planes = [];
  for (let k = 0; k < 6; k++) {
    planes.push(`<Planes E_Field="${box.e_file}_${k}.h5" H_Field="${box.h_file}_${k}.h5"/>`);
  }
  const threads = numThreads ? ` NumThreads="${numThreads}"` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<nf2ff freq="${Array.from(freqs, fmt).join(',')}" Outfile="${outfile}" Center="${center.map(fmt).join(',')}" Radius="${fmt(radius)}" Verbose="${verbose}"${threads}>
<theta>${rad(thetaDeg)}</theta>
<phi>${rad(phiDeg)}</phi>
${mirrors.join('\n')}${mirrors.length ? '\n' : ''}${planes.join('\n')}
</nf2ff>
`;
}

// Reads an nf2ff result file through an OpenEMSCore-like object with h5Read/h5Attr:
// {freqs, theta, phi (radians), prad[], dmax[], eTheta/ePhi: [{re, im}] per freq,
//  eNorm: [Float64Array] per freq}; fields are theta-major ([theta][phi] flattened),
//  like nf2ff_results.E_norm in Python.
export function readNf2ff(h5, file) {
  const theta = h5.h5Read(file, '/Mesh/theta').data;
  const phi = h5.h5Read(file, '/Mesh/phi').data;
  const freqs = Array.from(h5.h5Attr(file, '/nf2ff', 'Frequency') || []);
  const prad = Array.from(h5.h5Attr(file, '/nf2ff', 'Prad') || []);
  const dmax = Array.from(h5.h5Attr(file, '/nf2ff', 'Dmax') || []);
  const eTheta = [];
  const ePhi = [];
  const eNorm = [];
  const nt = theta.length;
  const np = phi.length;
  // current format: one complex dataset f<k> per frequency, stored (theta, phi);
  // legacy format (LegacyHDF5="1"): f<k>_real / f<k>_imag, stored (phi, theta)
  const field = (name, k) => {
    const re = new Float64Array(nt * np);
    const im = new Float64Array(nt * np);
    const names = new Set(h5.h5List(file).map((d) => d.path));
    if (names.has(`/nf2ff/${name}/FD/f${k}`)) {
      const d = h5.h5Read(file, `/nf2ff/${name}/FD/f${k}`).data;
      for (let j = 0; j < nt * np; j++) { re[j] = d[2 * j]; im[j] = d[2 * j + 1]; }
    } else {
      const r = h5.h5Read(file, `/nf2ff/${name}/FD/f${k}_real`).data;
      const i = h5.h5Read(file, `/nf2ff/${name}/FD/f${k}_imag`).data;
      for (let p = 0; p < np; p++) for (let t = 0; t < nt; t++) { re[t * np + p] = r[p * nt + t]; im[t * np + p] = i[p * nt + t]; }
    }
    return { re, im };
  };
  freqs.forEach((_, k) => {
    const et = field('E_theta', k);
    const ep = field('E_phi', k);
    const en = new Float64Array(nt * np);
    for (let j = 0; j < en.length; j++) en[j] = Math.sqrt(et.re[j] ** 2 + et.im[j] ** 2 + ep.re[j] ** 2 + ep.im[j] ** 2);
    eTheta.push(et);
    ePhi.push(ep);
    eNorm.push(en);
  });
  return { freqs, theta, phi, prad, dmax, eTheta, ePhi, eNorm };
}
