"""Offline tests for antennas/solver_log.py: no Docker or openEMS required."""
import ctypes
import os
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "antennas"))

from solver_log import SolverLog, diagnostic_warnings, tee_output, update_solver_diagnostics  # noqa: E402

# Lines as printed by openEMS RunFDTD / SetupFDTD (openems.cpp).
SETUP = [
    "FDTD timestep is: 1.53214e-12 s; Nyquist rate: 10 timesteps @3.26e+10 Hz",
    "Excitation signal length is: 1200 timesteps (1.83857e-09s)",
    "Max. number of timesteps: 20000 ( --> 16.6667 * Excitation signal length)",
    "[@        4s] Timestep:         3000 || Speed:  250.1 MC/s (  712 TS/s) || Energy: ~1.23e-14 (-12.34dB)",
]
CONVERGED = SETUP + [
    "RunFDTD: end-criteria of -40dB reached after 8123 timesteps (-40.12dB)",
    "Time for 8123 iterations with 1234567 cells : 33.2 sec",
]
MAX_REACHED = SETUP + [
    "RunFDTD: Warning: Max. number of timesteps was reached before the end-criteria of -40dB was reached... ",
    "\tYou may want to choose a higher number of max. timesteps... ",
    "Time for 20000 iterations with 1234567 cells : 80.0 sec",
]


def parse(lines):
    log = SolverLog()
    for line in lines:
        log.line(line)
    return log


class ParseTests(unittest.TestCase):
    def test_converged(self):
        log = parse(CONVERGED)
        self.assertEqual(log.solver["termination"], "converged")
        self.assertEqual(log.solver["executed_timesteps"], 8123)
        self.assertEqual(log.solver["final_energy_db"], -40.12)
        self.assertEqual(log.solver["excitation_timesteps"], 1200)
        self.assertEqual(log.solver["max_timesteps"], 20000)
        self.assertAlmostEqual(log.solver["timestep_s"], 1.53214e-12)
        self.assertEqual(log.all_warnings(), [])

    def test_max_timesteps_reached(self):
        log = parse(MAX_REACHED)
        self.assertEqual(log.solver["termination"], "max_timesteps")
        warnings = log.all_warnings()
        self.assertIn("Maximum timesteps reached without confirmed energy convergence.", warnings)
        self.assertTrue(any(w.startswith("RunFDTD: Warning: Max. number") for w in warnings))

    def test_older_openems_without_explicit_messages(self):
        # Older builds print only the iteration count; infer the limit as the JS does.
        d = {}
        for line in SETUP[:3] + ["Time for 20000 iterations with 10 cells : 1 sec"]:
            update_solver_diagnostics(d, line)
        self.assertEqual(d["termination"], "max_timesteps")
        d = {}
        for line in SETUP[:3] + ["Time for 9000 iterations with 10 cells : 1 sec"]:
            update_solver_diagnostics(d, line)
        self.assertEqual(d["termination"], "unknown")

    def test_aborted_with_and_without_decay(self):
        d = {}
        update_solver_diagnostics(d, "RunFDTD: simulation aborted after 500 timesteps")
        self.assertEqual((d["termination"], d["executed_timesteps"]), ("aborted", 500))
        self.assertNotIn("final_energy_db", d)
        update_solver_diagnostics(d, "RunFDTD: simulation aborted after 700 timesteps (-21.50dB)")
        self.assertEqual((d["executed_timesteps"], d["final_energy_db"]), (700, -21.5))

    def test_warnings(self):
        self.assertEqual(diagnostic_warnings({"excitation_timesteps": 1000, "executed_timesteps": 400,
                                              "termination": "aborted", "max_timesteps": 5000}),
                         ["Run ended before excitation finished; S11 and far-field are not reliable."])
        self.assertEqual(diagnostic_warnings({"excitation_timesteps": 1000, "max_timesteps": 2000}),
                         ["Maximum timesteps is below three times the excitation length."])

    def test_setup_warning_is_collected_once(self):
        line = "openEMS::SetupFDTD: Warning, the timestep seems to be very small --> long simulation. Check your mesh!?"
        self.assertEqual(parse([line, line]).warnings, [line])


class TeeTests(unittest.TestCase):
    """C-level output is both passed through and parsed."""

    def test_tee_captures_fd_writes_and_c_stdio(self):
        seen = []
        with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
            saved = os.dup(1), os.dup(2)
            os.dup2(out.fileno(), 1)
            os.dup2(err.fileno(), 2)
            try:
                with tee_output(lambda text, stream: seen.append((stream, text))):
                    os.write(1, b"Time for 42 iter")
                    os.write(1, b"ations with 1 cells : 1 sec\n")
                    os.write(2, b"RunFDTD: Warning: something\n")
                    os.write(1, b"partial line, ")
                    # Buffered C stdio with no trailing newline: tee_output must flush it before
                    # restoring fd 1 and emit the unterminated remainder at EOF.
                    ctypes.CDLL(None).printf(b"then C stdio")
            finally:
                os.dup2(saved[0], 1)
                os.dup2(saved[1], 2)
                os.close(saved[0])
                os.close(saved[1])
            out.seek(0)
            err.seek(0)
            stdout, stderr = out.read(), err.read()
        self.assertIn(b"Time for 42 iterations with 1 cells : 1 sec\n", stdout)
        self.assertTrue(stdout.endswith(b"partial line, then C stdio"))
        self.assertIn(b"RunFDTD: Warning: something\n", stderr)
        self.assertIn(("stdout", "Time for 42 iterations with 1 cells : 1 sec"), seen)
        self.assertIn(("stdout", "partial line, then C stdio"), seen)
        self.assertIn(("stderr", "RunFDTD: Warning: something"), seen)

    def test_fds_restored_after_exception(self):
        before = os.fstat(1).st_ino, os.fstat(2).st_ino
        with self.assertRaises(RuntimeError):
            with tee_output(lambda *_: None):
                raise RuntimeError("solver failed")
        self.assertEqual((os.fstat(1).st_ino, os.fstat(2).st_ino), before)


if __name__ == "__main__":
    unittest.main()
