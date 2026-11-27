"""Priority-based local refinement of a feature-aligned rectilinear grid.

Keep in sync with refinementSeeds in site/csxcad/js/sim/mesh.js. Return one
nonoverlapping set of fixed lines for the normal CSXCAD smoothing pass, or
None if every local spacing constraint is already satisfied.
"""
import math


def refinement_seeds(lines, protected_lines, regions, resolution, max_intervals=2500):
    lines = [float(v) for v in lines]
    targets = []
    for a,b in zip(lines,lines[1:]):
        target = resolution
        for lo,hi,step in regions:
            if step < target and hi > lo and lo < b and hi > a:
                target = step
        targets.append(target)
    if not any(t < resolution and lines[i+1]-lines[i] > t*(1+1e-12)
               for i,t in enumerate(targets)):
        return None
    hard = set(protected_lines)
    cuts = [0] + [i for i in range(1,len(lines)-1)
                  if lines[i] in hard or targets[i] != targets[i-1]] + [len(lines)-1]
    out = [lines[0]]
    limit = max(len(lines)-1,max_intervals)
    for i,j in zip(cuts,cuts[1:]):
        left,right,target = lines[i],lines[j],targets[i]
        count = (right-left)/target*(1-1e-12) if target < resolution else 1
        if not math.isfinite(count):
            raise ValueError("Refined mesh axis exceeds cell budget")
        n = max(1,math.ceil(count))
        if len(out)+n-1 > limit:
            raise ValueError("Refined mesh axis exceeds cell budget")
        step = (right-left)/n
        out.extend(left+k*step for k in range(1,n))
        out.append(right)
    return out
