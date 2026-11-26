"""Native CSXCAD geometry primitives for structured simulation schema v2.

Coordinates are mm. Geometry transform is intrinsic X/Y/Z rotations (degrees),
then translation, applied to world-space points before CSXCAD primitive creation.
"""
import math
import numpy as np


def vec3(value, label):
    out = np.asarray(value, dtype=float)
    if out.shape != (3,) or not np.all(np.isfinite(out)):
        raise ValueError(f"{label} must contain 3 finite coordinates")
    return out


def positive(value, name):
    x = float(value)
    if not math.isfinite(x) or x <= 0:
        raise ValueError(f"{name} must be positive")
    return x


def rotate(points, degrees):
    result = np.array(points, dtype=float, copy=True)
    roll, pitch, yaw = np.deg2rad(vec3(degrees, "rotation"))
    cx, sx = np.cos(roll), np.sin(roll)
    cy, sy = np.cos(pitch), np.sin(pitch)
    cz, sz = np.cos(yaw), np.sin(yaw)
    rx = np.array([[1,0,0],[0,cx,-sx],[0,sx,cx]])
    ry = np.array([[cy,0,sy],[0,1,0],[-sy,0,cy]])
    rz = np.array([[cz,-sz,0],[sz,cz,0],[0,0,1]])
    return result @ (rz @ ry @ rx).T


def transformed(points, geometry):
    transform = geometry.get("transform", {})
    r = transform.get("rotate_deg", [0, 0, 0])
    shift = vec3(transform.get("translate", [0, 0, 0]), "transform.translate")
    return rotate(points, r) + shift


def helix_points(g):
    origin = vec3(g["origin"], "helix.origin")
    axis = vec3(g.get("axis", [0, 0, 1]), "helix.axis")
    norm = np.linalg.norm(axis)
    if norm == 0:
        raise ValueError("helix.axis must be nonzero")
    axis /= norm
    trial = np.array([1.,0.,0.]) if abs(axis[0]) < 0.9 else np.array([0.,1.,0.])
    u = trial - axis * np.dot(trial, axis)
    u /= np.linalg.norm(u)
    v = np.cross(axis, u)
    turns = positive(g["turns"], "helix.turns")
    height = positive(g["height"], "helix.height")
    diameter = positive(g["diameter"], "helix.diameter")
    segments_per_turn = int(g.get("segments_per_turn", 24))
    if not (8 <= segments_per_turn <= 80) or turns * segments_per_turn > 8000:
        raise ValueError("Helix segments_per_turn must be 8..80, total segments <= 8000")
    count = max(2, int(math.ceil(turns * segments_per_turn)))
    phase = math.radians(float(g.get("phase_deg", 0)))
    t = np.linspace(0, 1, count + 1)
    alpha = 2 * np.pi * turns * t + phase
    return origin + t[:,None] * height * axis + (diameter/2) * (
        np.cos(alpha)[:,None] * u + np.sin(alpha)[:,None] * v)


def hemisphere_mesh(radius, thickness=None, lat_steps=10, azimuth_steps=32):
    """Triangulated +Z hemisphere, optionally with its inner shell and open rim."""
    r = positive(radius, "hemisphere.radius")
    if thickness is not None and not 0 < thickness < r:
        raise ValueError("hemisphere shell thickness must be between 0 and radius")
    rings = []
    verts = []
    faces = []
    radii = [r] if thickness is None else [r, r-thickness]
    for rad in radii:
        top_index = len(verts)
        verts.append([0, 0, rad])
        sets = []
        for level in range(1, lat_steps+1):
            theta = (math.pi/2) * level / lat_steps
            ring = []
            for j in range(azimuth_steps):
                phi = 2 * math.pi*j/azimuth_steps
                ring.append(len(verts))
                verts.append([rad*math.sin(theta)*math.cos(phi),
                              rad*math.sin(theta)*math.sin(phi),
                              rad*math.cos(theta)])
            sets.append(ring)
        rings.append((top_index,sets))
    top, outer = rings[0]
    for j in range(azimuth_steps):
        nxt=(j+1)%azimuth_steps
        faces.append([top,outer[0][j],outer[0][nxt]])
    for a,b in zip(outer[:-1],outer[1:]):
        for j in range(azimuth_steps):
            nxt=(j+1)%azimuth_steps
            faces.extend([[a[j],b[j],b[nxt]],[a[j],b[nxt],a[nxt]]])
    if thickness is None:
        cap=len(verts)
        verts.append([0,0,0])
        for j in range(azimuth_steps):
            faces.append([cap,outer[-1][(j+1)%azimuth_steps],outer[-1][j]])
    else:
        inner_top,inner=rings[1]
        for j in range(azimuth_steps):
            nxt=(j+1)%azimuth_steps
            faces.append([inner_top,inner[0][nxt],inner[0][j]])
        for a,b in zip(inner[:-1],inner[1:]):
            for j in range(azimuth_steps):
                nxt=(j+1)%azimuth_steps
                faces.extend([[a[j],b[nxt],b[j]],[a[j],a[nxt],b[nxt]]])
        for j in range(azimuth_steps):
            nxt=(j+1)%azimuth_steps
            faces.extend([[outer[-1][j],outer[-1][nxt],inner[-1][nxt]],
                          [outer[-1][j],inner[-1][nxt],inner[-1][j]]])
    return np.asarray(verts), faces


def add_polyhedron(material, vertices, faces, priority):
    prim = material.AddPolyhedron(priority=priority)
    for vertex in vertices:
        prim.AddVertex(*map(float,vertex))
    for face in faces:
        prim.AddFace(face)
    return prim


def box_data(start, stop):
    a=np.minimum(start,stop)
    b=np.maximum(start,stop)
    if np.any(a == b):
        # Degenerate planes are supported as 2D CSXCAD boxes; do not
        # make a non-manifold polyhedron for a transformed 2D sheet.
        return np.array([[x,y,z] for x in (a[0],b[0])
                         for y in (a[1],b[1]) for z in (a[2],b[2])]), []
    v=np.array([[a[0],a[1],a[2]],[b[0],a[1],a[2]],[b[0],b[1],a[2]],[a[0],b[1],a[2]],
                [a[0],a[1],b[2]],[b[0],a[1],b[2]],[b[0],b[1],b[2]],[a[0],b[1],b[2]]])
    f=[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],
       [1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]]
    return v, f


def install_geometry(material, g):
    """Returns (bounding min, bounding max, lightweight viewer preview)."""
    shape=g.get("shape", g.get("type"))
    priority=int(g.get("priority", 10))
    preview={"shape":shape, "name":g.get("name",shape), "material":g["material"]}
    if shape=="box":
        a=vec3(g["start"], "box.start")
        b=vec3(g["stop"], "box.stop")
        if np.any(a>b):
            raise ValueError("box.start must be <= box.stop")
        verts,faces=box_data(a,b)
        world=transformed(verts,g)
        rotated = not np.allclose(g.get("transform",{}).get("rotate_deg",[0,0,0]),0)
        if not faces and rotated:
            raise ValueError("Rotated zero-thickness boxes are unsupported: use a 3D box or a mesh")
        if not rotated:
            aa=transformed([a],g)[0]
            bb=transformed([b],g)[0]
            # A shifted zero-thickness box is still represented natively.
            prim=material.AddBox(start=aa.tolist(),stop=bb.tolist(),priority=priority)
            del prim
        else:
            add_polyhedron(material,world,faces,priority)
        preview.update({"vertices":world.tolist(),"faces":faces})
        lower,upper=world.min(axis=0),world.max(axis=0)
    elif shape in ("cylinder","cylindrical_shell"):
        a,b=transformed([vec3(g["start"],"cylinder.start"),
                          vec3(g["stop"],"cylinder.stop")],g)
        radius=positive(g["radius"],"cylinder.radius")
        if np.linalg.norm(b-a)==0:
            raise ValueError("cylinder start and stop must differ")
        if shape=="cylinder":
            material.AddCylinder(a.tolist(),b.tolist(),radius,priority=priority)
        else:
            width=positive(g["thickness"],"cylindrical_shell.thickness")
            if width>=2*radius:
                raise ValueError("cylindrical_shell.thickness must be less than diameter")
            material.AddCylindricalShell(a.tolist(),b.tolist(),radius,width,priority=priority)
            preview["thickness"]=width
        lower=np.minimum(a,b)-radius
        upper=np.maximum(a,b)+radius
        preview.update({"start":a.tolist(),"stop":b.tolist(),"radius":radius})
    elif shape in ("sphere","spherical_shell"):
        center=transformed([vec3(g["center"],"sphere.center")],g)[0]
        radius=positive(g["radius"],"sphere.radius")
        if shape=="sphere":
            material.AddSphere(center.tolist(),radius,priority=priority)
        else:
            width=positive(g["thickness"],"spherical_shell.thickness")
            if width>=radius:
                raise ValueError("spherical_shell thickness must be < radius")
            material.AddSphericalShell(center.tolist(),radius,width,priority=priority)
            preview["thickness"]=width
        lower=center-radius
        upper=center+radius
        preview.update({"center":center.tolist(),"radius":radius})
    elif shape in ("wire","helix"):
        if shape=="wire":
            points=np.asarray(g["points"],float)
            if points.ndim!=2 or points.shape[1]!=3 or len(points)<2 or len(points)>8001:
                raise ValueError("wire.points must be list of 2..8001 XYZ vertices")
        else:
            points=helix_points(g)
        if not np.all(np.isfinite(points)):
            raise ValueError("Non-finite wire coordinates")
        points=transformed(points,g)
        radius=positive(g["wire_diameter"],"wire_diameter")/2
        material.AddWire(points=points.T.tolist(),radius=radius,priority=priority)
        lower=points.min(axis=0)-radius
        upper=points.max(axis=0)+radius
        preview.update({"points":points.tolist(),"radius":radius})
    elif shape in ("hemisphere","hemispherical_shell"):
        width=positive(g["thickness"],"hemispherical_shell.thickness") if shape=="hemispherical_shell" else None
        radius=positive(g["radius"],"hemisphere.radius")
        verts,faces=hemisphere_mesh(radius,width)
        local=verts+vec3(g["center"],"hemisphere.center")
        world=transformed(local,g)
        add_polyhedron(material,world,faces,priority)
        lower=world.min(axis=0)
        upper=world.max(axis=0)
        preview.update({"vertices":world.tolist(),"faces":faces})
    elif shape=="polyhedron":
        # Native CSXCAD Polyhedron: closed triangle/polygon mesh (vertices + faces).
        verts=np.asarray(g["vertices"],float)
        if verts.ndim!=2 or verts.shape[1]!=3 or not 4<=len(verts)<=20000:
            raise ValueError("polyhedron.vertices must be a list of 4..20000 XYZ vertices")
        faces=g["faces"]
        if not isinstance(faces,list) or not 4<=len(faces)<=40000:
            raise ValueError("polyhedron.faces must be a list of 4..40000 faces")
        for face in faces:
            if (not isinstance(face,list) or len(face)<3 or
                    not all(isinstance(i,int) and not isinstance(i,bool) and 0<=i<len(verts) for i in face)):
                raise ValueError("polyhedron.faces must list >=3 valid vertex indices each")
        if not np.all(np.isfinite(verts)):
            raise ValueError("Non-finite polyhedron vertices")
        world=transformed(verts,g)
        add_polyhedron(material,world,faces,priority)
        lower=world.min(axis=0)
        upper=world.max(axis=0)
        # The results viewer draws triangles: fan-split polygon faces for the preview only.
        triangles=[[f[0],f[k],f[k+1]] for f in faces for k in range(1,len(f)-1)]
        preview.update({"vertices":world.tolist(),"faces":triangles})
    else:
        raise ValueError(f"Unsupported schema v2 shape: {shape!r}")
    if not (np.all(np.isfinite(lower)) and np.all(np.isfinite(upper))):
        raise ValueError("Non-finite geometry bounding box")
    return lower,upper,preview


def add_local_mesh(mesh, domain_start, domain_stop, lo, hi, step):
    """Introduce fixed local mesh lines around small conductor details."""
    step=positive(step,"mesh.local_min_cell_mm")
    for i,axis in enumerate("xyz"):
        left=max(domain_start[i],lo[i])
        right=min(domain_stop[i],hi[i])
        if right<=left:
            continue
        n=int(math.ceil((right-left)/step))+1
        if n>1800:
            raise ValueError(f"Local mesh region {axis} has {n} requested lines (> 1800)")
        mesh.AddLine(axis,np.linspace(left,right,n).tolist())
