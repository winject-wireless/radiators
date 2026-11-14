# FR4 4 × 4 inset-fed patch array, 2.4–2.5 GHz\n\n> **Simulation status (PR #4, 2026-11-15): FAILS the gain target.** An openEMS run completed successfully but found **−4.46 dBi realized broadside gain at 2.45 GHz**, with only **1.22% radiation efficiency**. This is an experimental simulation model for viewing and debugging, **not a validated antenna or a fabrication-ready PCB**. The very low efficiency needs model and feed-network investigation, followed by mesh convergence and physical measurements.

## Initial openEMS results

| Frequency | S11 (dB) | Directivity (dBi) | Radiation efficiency | Realized gain (dBi) |
|---|---:|---:|---:|---:|
| 2.400 GHz | −13.98 | 14.94 | 1.28% | −4.17 |
| 2.425 GHz | −13.97 | 14.88 | 1.23% | −4.39 |
| 2.450 GHz | −14.05 | 14.84 | 1.22% | −4.46 |
| 2.475 GHz | −14.20 | 14.82 | 1.25% | −4.37 |
| 2.500 GHz | −14.41 | 14.83 | 1.32% | −4.14 |

Source: [PR #4 openEMS simulation run](https://github.com/winject-wireless/radiators/actions/runs/43617401417), artifact `structured-openems-results`. High directivity alone does not imply high realized gain. These results must be debugged; S11 by itself is not evidence of efficient radiation.

---

**Status: experimental simulation, not validated for fabrication. The first full-wave run missed the gain target.**

## Objectives

- One 50 Ω RF port, 16 coherent linearly polarized radiating patches, broadside +Z.
- ≥9 dBi **boresight realized gain** at 2.400, 2.425, 2.450, 2.475 and 2.500 GHz.
- Preferably S11 ≤ −10 dB continuously from 2.400–2.500 GHz; this is a separate unverified goal.

## Dimensions / material

| Parameter | Initial value |
|---|---|
| Board and full underside ground | 280 × 289 mm |
| Stackup | Two-layer FR4, h = 1.6 mm, εr = 4.3, assumed tanδ = 0.020 @ 2.45 GHz |
| Lossy dielectric model | εr = 4.3, κ = 0.011721768 S/m at f0 |
| Copper | 35 µm conducting sheet, 5.8e7 S/m |
| Patch (X width × Y resonant length) | 37.584 × 29.138 mm |
| Patch-center pitch | 72 mm X and 78 mm Y |
| Patch feed | Bottom-edge inset, 9.0 mm deep; 5.137 mm wide slot |
| 50 Ω microstrip | 3.137 mm width (first-order formula) |
| 70.711 Ω transformer | 1.641 mm width × 17.338 mm quarter-wave length |
| Feed tree | Single-layer corporate H-tree, 15 junctions, 30 equal-split quarter-wave arms |
| Feed at board coordinate | (X, Y) = (0, −20) mm, idealized z-direction 50 Ω lumped launch |

All 16 patches are fed from **the same radiating edge**. Do not mirror half the patches to face the array center without adding and verifying the required phase correction.

Patch centers: X = [−108, −36, 36, 108] mm; Y = [−117, −39, 39, 117] mm. Row T-junction Y: [−137, −59, 19, 97] mm, at X = ±72 mm. Quadrant T-junctions: X = ±72 mm, Y = [−98, 58] mm. The central input is at (0, −20) mm. The root-to-patch electrical geometry is symmetric to first order.

## Run with the existing radiators pipeline

```bash
docker build -t radiators-openems:ci -f docker/openems/Dockerfile .
docker run --rm -v "$PWD:/work" -w /work radiators-openems:ci \
  python antennas/simulate.py antennas/patch_array_4x4_fr4_2450.json \
  --output results/patch_array_4x4_fr4_2450
```

The existing GitHub Actions workflow also selects changed `antennas/*.json` files automatically. This model requests 2 CPUs / 10 GiB, a maximum 8-million-cell mesh, 0.5 mm inset refinements, a 2.35–2.55 GHz S11 sweep at 5 MHz spacing and five far-field frequencies.

Inspect **boresight realized gain** at θ=0°, rather than relying on the viewer's peak gain. Verify S11, impedance, efficiency, cross-polarization, sidelobes, front-to-back ratio and mesh convergence before manufacturing.

## Important caveats

1. The initial patch dimensions, microstrip impedances and quarter-wave lengths are transmission-line approximations. Tune patch resonant length, inset depth and transformer lines in a converged EM simulation.
2. A 100 MHz band is ~4.08% fractional bandwidth. Standard 1.6 mm FR4 patch elements may not sustain S11 ≤ −10 dB over this entire interval without geometric or stackup modifications.
3. Corporate feedlines on lossy FR4 are long. Dielectric, copper and junction losses, unintended feed radiation, mutual coupling and the launch can reduce gain.
4. The z-directed lumped feed approximates an SMA launch; there is no coax connector or launch parasitic in the model. The SVG is a **geometry preview, not a Gerber file or PCB DRC result**.
5. Full-wave simulations, material tolerance sweeps and VNA/chamber tests must precede any claim of ≥9 dBi realized gain.

Reference studies on other FR4 4×4 patch arrays report both ~9 dBi and ~12 dBi class gains; they do not validate this particular geometry:
- https://www.ijraset.com/research-paper/planar-rectangular-microstrip-patch-antenna-array-with-corporate-feed-network
- https://ies.pens.ac.id/2021/wp-content/uploads/2021/09/Program-Book-IES-2021.pdf
