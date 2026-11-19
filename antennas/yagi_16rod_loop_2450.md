# Photo-inspired 2.45 GHz loop-driven Yagi (16 straight rods)

## Source and accounting

The supplied photograph is marked **“2.4G 16单元 Yagi”**. Inspection shows 16 straight transverse rods, the loop-style driven element near the right-hand end, and the 16th rod behind the loop. This model therefore has **15 directors + 1 loop driven element + 1 reflector = 17 discrete conductors**, of which 16 are straight rods. Manufacturer element-count conventions may differ; there is no exact dimension reference in the photo.

**Status: EXPERIMENTAL — FAILS the gain and matching targets.** The corrected openEMS simulation has converged, but peak realized gain is −2.45 dBi at 2.45 GHz, with only −11.47 dBi in the intended forward (−X) direction. VSWR is 14.97:1, and the pattern peaks sideways at approximately ±Y instead of endfire −X. The ~16 dBi reference is a comparison target only; **do not fabricate this model as a working Yagi without redesigning and revalidating it.**

## Validated solver run and key numbers

- [Successful PR workflow #44465459293](https://github.com/winject-wireless/radiators/actions/runs/44465459293), 2026-11-19 UTC; the openEMS run reached its −40 dB energy stop criterion at 3552 timesteps (−52.65 dB).
- Numerical mesh correction: uniform 2 mm grid with 3,196,800 total FDTD mesh cells; 3.85167 ps timestep. The preceding run's tiny cells caused a truncated excitation; do not use those prior gain numbers.

| Frequency | Peak directivity | Peak realized gain | S11 | Radiation efficiency |
|---|---:|---:|---:|---:|
| 2400 MHz | +3.75 dBi | −2.40 dBi | −1.21 dB | 99.96% |
| 2450 MHz | +3.85 dBi | −2.45 dBi | −1.16 dB | 99.90% |
| 2500 MHz | +3.94 dBi | −2.48 dBi | −1.12 dB | 99.96% |

At 2450 MHz: intended forward (−X) realized gain **−11.47 dBi**; Z_in ≈ **537.5 + j335.9 Ω**; VSWR **14.97**. This is an ideal PEC simulation, with no real coax/balun/boom. Mesh-convergence sweeps still required before any manufacturing prediction.


## Coordinate system and dimensions

- Operating center: 2450 MHz; wavelength: 122.364 mm
- Main beam: **towards decreasing X** (from reflector through loop to directors). Polarization: predominantly Z.
- 15 round directors: centers X=0 to 364 mm, every 26 mm; diameter 3.0 mm; lengths taper 49.8 mm (front) to 53.4 mm (nearest driven).
- Loop driven element: elliptical rounded *folded-loop* in the XZ plane, centered at X=390 mm. Outer centerline semi-axes: X=11 mm, Z=28 mm; 1.8 mm wire; 4.0 mm open gap on the back side of the ellipse at X≈400.97 mm, bridged by an ideal 50 ohm Z-axis lumped port on grid-aligned X=401 mm. This is **not** a small magnetic loop in a plane transverse to the beam. It is a folded electric-dipole-like radiator.
- Reflector: center X=416 mm, diameter 3.0 mm, length 62.0 mm.
- Structure span from front director to reflector: 416 mm. Approximate rod tip-to-tip height: 62 mm. No modelled mechanical boom.
- Model PEC conductor material (ideal lossless); no explicit coaxial connector, balun, dielectric spacers, metallic boom, U-bolts, or plastic end caps.

| Item | Position X (mm) | Length / overall height (mm) |
|---|---:|---:|
| Reflector | 416 | 62.0 |
| Loop (center) | 390 | 56.0 centerline height |
| Director 15 | 364 | 53.4 |
| Director 14 | 338 | 53.14 |
| Director 13 | 312 | 52.89 |
| Director 12 | 286 | 52.63 |
| Director 11 | 260 | 52.37 |
| Director 10 | 234 | 52.11 |
| Director 9 | 208 | 51.86 |
| Director 8 | 182 | 51.6 |
| Director 7 | 156 | 51.34 |
| Director 6 | 130 | 51.09 |
| Director 5 | 104 | 50.83 |
| Director 4 | 78 | 50.57 |
| Director 3 | 52 | 50.31 |
| Director 2 | 26 | 50.06 |
| Director 1 | 0 | 49.8 |

## Simulator use

In the repository root:

```bash
python antennas/simulate.py antennas/yagi_16rod_loop_2450.json --output results/yagi_16rod_loop_2450
```

Run inside the openEMS-enabled Docker image described in antennas/README.md (not the system Python). The existing GitHub Actions workflow picks up the antenna JSON on PRs, and publishes results on main after a passing simulation. Simulation cost depends on the generated 3D mesh; refine only after a successful baseline.

## Validation before fabricating

1. Inspect 2.4/2.45/2.5 GHz **boresight** realized gain along −X, not only the peak directivity; S11 below −10 dB over the desired Wi-Fi channels is a goal, not a reported outcome.
2. Verify no unexpected rearward lobe, feed impedance, radiation efficiency, front-to-back ratio, and 3 dB beamwidth. Because the loop feed model has no balun, actual coax may alter currents.
3. Perform mesh-convergence reruns at a **finer** step than 2 mm, with refined loop gap meshing; the current grid is merely a stable baseline and may not resolve 1.8–3.0 mm conductors sufficiently.
4. Obtain physical dimensions from the photographed unit. The image alone cannot establish rod length, rod diameter, spacing, boom electrical bonding, or the exact feed topology. The metallic boom and supports may measurably change the impedance and pattern.
5. Tune director taper and spacing, loop geometry, reflector offset and balun/matching against realized gain + VSWR, without simply declaring 16 dBi from an element count.

## Why this orientation

The photographed oval is interpreted as a folded dipole / folded loop driven element in the **XZ plane**, with its E field parallel to the straight Z rods. A magnetic loop placed entirely in the YZ plane would have a boresight null and is not the intended geometry.
