# Photo-informed measured-reference Yagi, bonded 16 mm aluminum boom

**Status: PROVISIONAL EXPERIMENTAL MODEL, NOT A VERIFIED CLONE OR PERFORMANCE CLAIM.** This is a new config in addition to the previous baseline `yagi_16rod_loop_2450.json`, which had no metallic boom. Do not merge to published `main` or manufacture until missing dimensions and feed topology are verified.

## Supplied measurements (2026-11-19)

- 15 directors, each **51.6 mm overall length including rigid plastic end caps**.
- 1 reflector, **66.6 mm overall length including caps**.
- Reported element diameter **8 mm**, potentially the cap OD rather than the underlying aluminum OD (not distinguished by the report).
- Boom section **16 mm × 16 mm**, aluminum.
- All **director and reflector rods are electrically bonded to the boom as one conductor**.
- Antenna shown with a separate oval loop driven element and a coax lead. The loop's actual electrical connection to the boom and exact feed geometry are not known.

## Important distinction: capped overall length versus conductive length

Plastic caps are insulating. Their measured outer tips cannot automatically be treated as the ends of the conductive rods. The conductor tips may stop inside the caps or extend almost to the tips; both the cap protrusion past the metal and any conductive metal beneath the caps are unknown. This model uses the reported overall lengths as **conductor upper bounds only**, not verified physical aluminum lengths. Similarly the modeled **8 mm metal OD is provisional** until the aluminum diameter is measured without the cap.

## Current model assumptions (unverified)

| Item | Current model | Confidence |
|---|---|---|
| Director count | 15 | User measured |
| Director conductor length | 51.6 mm, each, no taper | Provisional **upper bound**; caps included in actual measurement |
| Reflector conductor length | 66.6 mm | Provisional **upper bound**; caps included in actual measurement |
| Director and reflector diameter | 8.0 mm | Provisional; may be the plastic cap diameter |
| Boom outer cross-section | 16 × 16 mm | User measured |
| Boom length | 428 mm (X=−32 to +396) | Photo-derived estimate; not measured |
| Director pitch | 24 mm center-to-center (X=0..336) | Photo-derived estimate; please measure |
| Loop-to-nearest-director and loop-to-reflector spacing | 24 mm each | Same photo estimate |
| Driven oval loop | XZ plane, 22 × 56 mm centerline size, 1.8 mm conductor | Previous guessed geometry, not measured |
| Loop plane | Y=−16 mm, clear of boom by about 7.1 mm metal-to-metal | **Assumed insulated offset**; actual spacer/connection unknown |
| Loop feed | Single ideal 50 Ω 4-mm gap at rear of loop, centered X=371 | Idealization; no coax/balun/connector metal |
| Passive metal and boom | Multiple overlapping ideal PEC shapes representing a single electrically bonded metal conductor | Grounded construction, conductivity idealized |

Photo pitch cross-check: about 79 pixels between successive directors; the boom is roughly 53–54 pixels high. Normalizing by the measured 16 mm boom gives **~23–24 mm** approximate center-to-center director pitch. This photo is not a measurement of the actual 3D spacings and perspective introduces error.

## Electromagnetic modeling details

- All passive rods overlap the PEC boom volume through their centers and share the same named conductor material. The lumped port excites **only the loop**, which is placed outside the boom and uses a different material object; this avoids an accidental electrical short across the loop's 4-mm gap.
- **PEC is an engineering surrogate for aluminum**, not a declaration that aluminum is lossless. At 2.45 GHz its electromagnetic skin depth is of order microns; a 2-mm bulk finite-conductivity mesh cannot resolve it. A correct aluminum-loss calculation needs a suitable surface-impedance / conductive-sheet treatment or validated thin skin-layer model.
- The original model put the oval loop in the boom midplane. In the new model it is offset from the boom, but **the real mechanical mounting and coax-to-loop connections still require inspection**.
- The solid PEC boom models the external conductor surface of a square aluminum tube. Hollow wall details, fasteners, oxidation, interfaces, plastic caps and conductive paint are omitted.
- A 2-mm uniform FDTD grid avoids the nearly coincident geometry cells that previously caused time-step collapse. It does **not** establish mesh convergence, especially near the loop feed.

## Simulator verification criteria

1. Confirm the solver reaches its energy stop criterion and does not truncate excitation.
2. Compare S11, complex input impedance, radiation efficiency, **forward −X realized gain** and peak realized gain at 2.4, 2.45, and 2.5 GHz.
3. Verify a true endfire pattern, not simply a high peak in another direction; measure front/back and sidelobes.
4. Re-run after measuring aluminum (uncapped) lengths, actual rod aluminum OD, center-to-center pitch, exact loop outline, loop offset, feed gap and actual boom length.
5. Compare against old isolated-rod model, but do not attribute differences solely to bonding until all other geometry variables are held fixed.

## Geometry details

The first director is at X=0; all 15 directors have 24-mm spacing, so the last is X=336. The driven loop center is X=360 and the reflector is X=384. The boom extends X=−32 to +396. The boresight target is −X with the rods along Z. Loop centerline Y=−16; boom occupies Y=−8..+8 and Z=−8..+8, avoiding unintended touching. The loop PEC object must remain isolated from the passive-boom PEC object.

## How to run

```bash
python antennas/simulate.py antennas/yagi_16rod_bonded_boom_2450.json --output results/yagi_16rod_bonded_boom_2450
```

Run inside the repository's openEMS-enabled environment as documented in `antennas/README.md`.
