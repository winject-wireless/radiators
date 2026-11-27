"""Finest-wins refinement of a feature-aligned rectilinear Yee grid.

Keep the native and browser (site/csxcad/js/sim/mesh.js refineAxis) algorithms
in sync. Refinement box boundaries are soft, geometry and port lines are fixed.
"""
import math


def refine_axis(lines, regions, resolution, growth, max_intervals=2500):
    lines = [float(v) for v in lines]
    spans = [b-a for a,b in zip(lines, lines[1:])]
    def ceil_parts(x):
        if not math.isfinite(x):
            raise ValueError("Refined mesh axis exceeds cell budget")
        return max(1, math.ceil(x*(1-1e-12)))

    parts = []
    for i, width in enumerate(spans):
        target = resolution
        for lo, hi, step in regions:
            if step < target and hi > lo and lo < lines[i+1] and hi > lines[i]:
                target = step
        parts.append(ceil_parts(width/target) if target < resolution else 1)
    if all(n == 1 for n in parts):
        return lines
    total = sum(parts)
    limit = max(len(spans), max_intervals)

    def check_budget():
        if total > limit:
            raise ValueError(f"Refined mesh axis exceeds cell budget: {total} > {limit}")
    check_budget()

    def grade(a,b):
        nonlocal total
        ratio = max(growth, spans[a]/spans[b])
        n = ceil_parts(spans[a]/(ratio*spans[b]/parts[b]))
        if n <= parts[a]:
            return False
        total += n-parts[a]
        check_budget()
        parts[a] = n
        return True

    changed = True
    while changed:
        changed = False
        for i in range(1,len(spans)):
            if grade(i,i-1):
                changed = True
        for i in range(len(spans)-2,-1,-1):
            if grade(i,i+1):
                changed = True
    out = [lines[0]]
    for i,n in enumerate(parts):
        width = spans[i]/n
        out.extend(lines[i]+j*width for j in range(1,n))
        out.append(lines[i+1])
    return out
