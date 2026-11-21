"""Parametric PEC racetrack loop with a central gap on the right straight leg.

Generator signature: generate(config, params) -> complete schema v2 config.
Geometry lies in XZ; antenna center is at (0, 0, 0). Feed is centered at z=0.
The *centerline* perimeter is one free-space wavelength at the design frequency;
the metal-to-metal feed gap is controlled independently of conductor diameter.
"""
import math

C0 = 299792458.0


def generate(config, params):
    aspect = float(params["aspect_ratio"])
    diameter = float(params["conductor_mm"])
    air_gap = float(params.get("feed_gap_mm", 4.0))
    frequency = float(params.get("design_frequency_hz", 2.45e9))
    if not (1.2 <= aspect <= 5.0 and 0.5 <= diameter <= 12 and
            0.5 <= air_gap <= 15 and 1e8 <= frequency <= 20e9):
        raise ValueError("Racetrack parameters out of supported range")

    perimeter = C0 * 1000 / frequency
    width = perimeter / (math.pi + 2 * (aspect - 1))
    radius = width / 2
    half_straight = width * (aspect - 1) / 2
    # A wire primitive is a finite-radius conductor. Keep the centerline gap
    # larger than its diameter to leave the requested physical air gap.
    centerline_gap = air_gap + diameter
    if centerline_gap >= 2 * half_straight:
        raise ValueError("Feed gap exceeds racetrack straight section")
    if diameter > width / 3:
        raise ValueError("Conductor is too thick relative to racetrack width")

    points = []
    # Start just above the central right-side feed gap, move counterclockwise
    # over the top semicircle, down the left straight and along the bottom arc.
    for i in range(9):
        z = centerline_gap / 2 + (half_straight - centerline_gap / 2) * i / 8
        points.append([radius, 0, z])
    for i in range(1, 37):
        theta = math.pi * i / 36
        points.append([radius * math.cos(theta), 0,
                       half_straight + radius * math.sin(theta)])
    for i in range(1, 17):
        points.append([-radius, 0, half_straight - 2 * half_straight * i / 16])
    for i in range(1, 37):
        theta = math.pi + math.pi * i / 36
        points.append([radius * math.cos(theta), 0,
                       -half_straight + radius * math.sin(theta)])
    for i in range(1, 9):
        z = -half_straight + (half_straight - centerline_gap / 2) * i / 8
        points.append([radius, 0, z])

    config["geometry"] = [{
        "name": "center-fed-racetrack-loop",
        "shape": "wire",
        "material": "pec-metal",
        "wire_diameter": diameter,
        "points": points,
        "priority": 10,
    }]
    config["ports"] = [{
        "id": 1, "name": "center-gap-50ohm", "type": "lumped",
        "start": [radius, 0, -centerline_gap / 2],
        "stop": [radius, 0, centerline_gap / 2],
        "direction": "z", "impedance_ohm": 50, "excite": True,
    }]
    # Keep domain fixed across the sweep so results are comparable.
    half_h = half_straight + radius
    if half_h + diameter / 2 > 105 or radius + diameter / 2 > 105:
        raise ValueError("Racetrack extends too near the PML boundary")
    config["mesh"]["refinements"] = [{
        "start": [-radius - diameter - 3, -diameter - 3, -half_h - diameter - 3],
        "stop": [radius + diameter + 3, diameter + 3, half_h + diameter + 3],
        "resolution_mm": min(1.0, diameter / 2),
    }]
    return config
