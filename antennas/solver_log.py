"""openEMS solver-log diagnostics for the native simulator.

Mirrors updateSolverDiagnostics / diagnosticWarnings / solverWarning in
site/csxcad/js/sim/diagnostics.js and run.js, so a native result.json reports
termination (converged / max_timesteps / aborted) the same way a browser run does.
Keep the patterns in sync with the JavaScript.

openEMS prints from C++ straight to file descriptors 1 and 2, so tee_output()
redirects those descriptors (not just sys.stdout) while still passing every
byte through to the original stream.
"""
from contextlib import contextmanager
import ctypes
import os
import re
import sys
import threading

_TIMESTEP = re.compile(r"FDTD timestep is:\s*([\d.eE+-]+)\s*s")
_EXCITATION = re.compile(r"Excitation signal length is:\s*(\d+)\s*timesteps")
_MAX_TS = re.compile(r"Max\. number of timesteps:\s*(\d+)")
_PROGRESS = re.compile(r"Timestep:\s*(\d+)")
_CONVERGED = re.compile(r"end-criteria.*?reached after\s*(\d+)\s*timesteps\s*\(([-\d.]+)dB\)", re.I)
_ABORTED = re.compile(r"simulation aborted after\s*(\d+)\s*timesteps(?:\s*\(([-\d.]+)dB\))?", re.I)
_MAX_REACHED = re.compile(r"max\. number of timesteps was reached before the end-criteria", re.I)
_TIME_FOR = re.compile(r"Time for\s*(\d+)\s*iterations", re.I)
_WARNING = re.compile(r"\bwarning\s*[:,]", re.I)


def update_solver_diagnostics(d, line):
    """Update the solver diagnostics dict `d` from one log line."""
    if (m := _TIMESTEP.search(line)):
        d["timestep_s"] = float(m[1])
    if (m := _EXCITATION.search(line)):
        d["excitation_timesteps"] = int(m[1])
    if (m := _MAX_TS.search(line)):
        d["max_timesteps"] = int(m[1])
    if (m := _PROGRESS.search(line)):
        d["executed_timesteps"] = int(m[1])
    if (m := _CONVERGED.search(line)):
        d["executed_timesteps"] = int(m[1])
        d["final_energy_db"] = float(m[2])
        d["termination"] = "converged"
    if (m := _ABORTED.search(line)):
        d["executed_timesteps"] = int(m[1])
        if m[2] is not None:
            d["final_energy_db"] = float(m[2])
        d["termination"] = "aborted"
    if _MAX_REACHED.search(line):
        d["termination"] = "max_timesteps"
    if (m := _TIME_FOR.search(line)):
        d["executed_timesteps"] = int(m[1])
        if "termination" not in d:
            limit = d.get("max_timesteps")
            d["termination"] = "max_timesteps" if limit is not None and d["executed_timesteps"] >= limit else "unknown"


def solver_warning(line):
    """An openEMS warning line, stripped, or None (run.js solverWarning)."""
    message = str(line).strip()
    return message if _WARNING.search(message) else None


def diagnostic_warnings(d):
    """Run-level warnings derived from the parsed solver diagnostics."""
    warnings = []
    excitation = d.get("excitation_timesteps")
    executed = d.get("executed_timesteps")
    if excitation and executed is not None and executed < excitation:
        warnings.append("Run ended before excitation finished; S11 and far-field are not reliable.")
    elif d.get("termination") == "max_timesteps":
        warnings.append("Maximum timesteps reached without confirmed energy convergence.")
    elif d.get("termination") == "aborted":
        warnings.append("Run aborted before confirmed convergence.")
    limit = d.get("max_timesteps")
    if excitation and limit is not None and limit < 3 * excitation:
        warnings.append("Maximum timesteps is below three times the excitation length.")
    return warnings


class SolverLog:
    """Collects diagnostics and openEMS warning lines from streamed output."""

    def __init__(self):
        self.solver = {}
        self.warnings = []
        self._lock = threading.Lock()

    def line(self, text, stream=None):
        with self._lock:
            update_solver_diagnostics(self.solver, text)
            warning = solver_warning(text)
            if warning and warning not in self.warnings:
                self.warnings.append(warning)

    def all_warnings(self):
        with self._lock:
            out = list(self.warnings)
            for message in diagnostic_warnings(self.solver):
                if message not in out:
                    out.append(message)
            return out


def _flush_c_stdio():
    try:
        ctypes.CDLL(None).fflush(None)
    except (OSError, AttributeError):
        pass


def _pump(read_fd, original_fd, on_line, stream):
    pending = b""

    def emit(raw):
        try:
            on_line(raw.decode("utf-8", errors="replace").rstrip("\r"), stream)
        except Exception:  # never let parsing stall the solver's output pipe
            pass

    with os.fdopen(read_fd, "rb", buffering=0) as reader:
        while True:
            chunk = reader.read(65536)
            if not chunk:
                break
            view = memoryview(chunk)
            while view:
                written = os.write(original_fd, view)
                view = view[written:]
            pending += chunk
            *lines, pending = pending.split(b"\n")
            for raw in lines:
                emit(raw)
    if pending:
        emit(pending)


@contextmanager
def tee_output(on_line):
    """Pass fd 1/2 output through unchanged and call on_line(text, stream) per line.

    Captures output written by C/C++ code in this process (openEMS), not only
    Python's sys.stdout / sys.stderr.
    """
    sys.stdout.flush()
    sys.stderr.flush()
    _flush_c_stdio()
    saved, threads = {}, []
    try:
        for fd, stream in ((1, "stdout"), (2, "stderr")):
            read_fd, write_fd = os.pipe()
            saved[fd] = os.dup(fd)
            os.dup2(write_fd, fd)
            os.close(write_fd)
            thread = threading.Thread(target=_pump, args=(read_fd, saved[fd], on_line, stream), daemon=True)
            thread.start()
            threads.append(thread)
        yield
    finally:
        try:
            sys.stdout.flush()
            sys.stderr.flush()
        finally:
            _flush_c_stdio()
            # Pointing fd 1/2 back at the originals drops the last pipe writer: readers see EOF.
            for fd, original in saved.items():
                os.dup2(original, fd)
            for thread in threads:
                thread.join()
            for original in saved.values():
                os.close(original)
