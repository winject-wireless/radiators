# Diagnostic probes and field playback

The Diagnostics section in the CSXCAD model tree adds passive objects. Both
browser/WASM and remote native openEMS use the same diagnostic result format.
WASM reads HDF5 through its existing exported API; no separate JS HDF5 library
or solver rebuild is required.

- Current: a plane, with the normal indicating positive current. In the Model tree, use Edit to select the normal and a single shared plane position. The two in-plane corners define its area. Existing thick boxes can be repaired with Flatten to plane, which preserves the start coordinate on the selected normal. Changing a valid plane normal rotates its extent about the start corner. Dragging either corner moves the shared normal coordinate without introducing thickness.
- Voltage: an axis-aligned line, with the line direction as reference.
- E/H point: a single XYZ position, returns three components.
- Field dump: a plane or volume, returns E/H/J/J_total/D/B vectors.
  J_total is curl(H), including displacement current, not surface current.
- Coordinates use mm, expressions work in the same way as geometry, and
  translation and rotations in multiples of 90 degrees are supported.

## Example: three-element Yagi current measurements

Add the following array to a schema-v2 model with len, dist_ref, dist_dir and
gap parameters. All probes have a +Z reference, use the same cross-section,
and are above the driven feed. Increase the plane width if the native snapped
mesh does not enclose the conductor.

```json
{
  "probes": [
    {"name":"I_driven","type":"current",
     "start":[-5,-5,{"$expr":"gap/2+2"}],
     "stop":[5,5,{"$expr":"gap/2+2"}],"direction":"z"},
    {"name":"I_reflector","type":"current",
     "start":[-5,{"$expr":"-dist_ref*len-5"},{"$expr":"gap/2+2"}],
     "stop":[5,{"$expr":"-dist_ref*len+5"},{"$expr":"gap/2+2"}],"direction":"z"},
    {"name":"I_director","type":"current",
     "start":[-5,{"$expr":"dist_dir*len-5"},{"$expr":"gap/2+2"}],
     "stop":[5,{"$expr":"dist_dir*len+5"},{"$expr":"gap/2+2"}],"direction":"z"},
    {"name":"H-plane","type":"field_dump","field":"H",
     "start":[0,-60,-45],"stop":[0,60,45],
     "sub_sampling":[1,3,3],"time_domain":{"enabled":true},
     "frequency_domain":{"enabled":true,"frequencies_hz":[2450000000]}}
  ]
}
```

Time-domain capture defaults to enabled. Frequency capture is opt-in.
Time-domain oversampling may be set under time_domain.oversampling. Native
sampling timestamps are retained; E and H use different staggered times.
Set dump_mode to node (default) or cell to select native field interpolation.
Node interpolation can distort normal components at material boundaries.

## Results

Open Results / Diagnostic probes and fields. Play/pause, seek, speed,
spatial stride and arrow length controls affect visualization only. Scalar
graphs share a cursor with the canvas. Negative values reverse their arrows.
Same-unit arrows use a fixed shared peak scale, so parasitic current magnitudes
can be compared. Field arrows originate at the native sampled mesh points.
Scalar probes use native snapped coordinates when reported. Time-domain fields
use the nearest actual recorded frame; scalar traces interpolate between samples.
Frequency-domain phase animation reconstructs complex phasors and is distinct
from recorded time. Frequency magnitudes and phases have separate plots.

The first transport format embeds little-endian float32 field blocks as base64
in the existing result JSON, so the current download/cache path includes
diagnostics. A separate streamed binary artifact transport is future work.
There is a 4096-point limit per dump and an aggregate four-million-sample-value
transfer budget; an oversized or missing capture reports a diagnostic warning.
Raw native HDF5 files may still be large before this postprocessing limit is
applied. Use small planes and spatial subsampling first.

## Tests

```sh
node site/csxcad/tools/check_probe_playback.mjs
python3 -m unittest discover -s scripts -p test_v2_diagnostics.py -v
```

The Python tests use NumPy, h5py, synthetic native-format samples and mocked
CSXCAD calls. A native openEMS integration run is still required before
releasing the feature.
