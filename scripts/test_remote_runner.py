"""Offline API tests: no Docker, network access outside loopback or openEMS required."""
import copy
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from unittest.mock import patch

from launch_remote_runner import load_config, server_command
from remote_runner import Handler, Runner, validate

TOKEN = "a" * 32
ORIGIN = "https://editor.example"
ID = "1" * 32
CONFIG = {"schema_version": 2, "units": "mm", "name": "test",
          "geometry": [{"name":"d", "shape":"box"}],
          "solver":{"resources":{"cpus":2,"memory_gib":1}},
          "mesh":{"max_cells":1000}}


class RemoteTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.args = SimpleNamespace(max_cpus=4,max_cells=10000,
            max_timesteps=100000,retain=2,token=TOKEN,origin=[ORIGIN])
        self.runner = Runner(self.args, [], Path(self.temp.name))

    def test_private_config(self):
        path = Path(self.temp.name)/"settings"/"config.json"
        a = load_config(path)
        self.assertEqual(a,load_config(path))
        self.assertEqual(path.stat().st_mode & 0o777,0o600)
        self.assertNotIn(a["token"],server_command(a))
        self.assertNotIn("max_memory_gib",a)
        a["max_memory_gib"]=48  # existing settings are accepted, but ignored
        self.assertNotIn("--max-memory-gib",server_command(a))

    def test_limits(self):
        cfg=copy.deepcopy(CONFIG)
        self.assertEqual(validate({"id":ID,"config":cfg},self.args)[2:],(2,))
        cfg["solver"]["resources"]["memory_gib"]=24
        self.assertEqual(validate({"id":ID,"config":cfg},self.args)[2:],(2,))
        cfg["solver"]["resources"]["cpus"]=5
        with self.assertRaises(ValueError): validate({"id":ID,"config":cfg},self.args)
        cfg=copy.deepcopy(CONFIG)
        cfg["scripts"]={}
        with self.assertRaises(ValueError): validate({"id":ID,"config":cfg},self.args)

    def test_parallel_cpu_budget_ignores_memory_metadata(self):
        gate=threading.Event()
        entered=[]
        def fake(j, cpus):
            with self.runner.lock:
                entered.append(j["id"])
                j["state"]="running"
            gate.wait(3)
            with self.runner.lock:
                j.update(state="done",seconds=.01)
        def wait_for(predicate):
            for _ in range(200):
                if predicate(): return
                time.sleep(.01)
            self.fail("scheduler did not reach expected state")
        with patch.object(self.runner,"execute",side_effect=fake):
            try:
                for ident in ("1"*32,"2"*32,"3"*32):
                    cfg=copy.deepcopy(CONFIG)
                    cfg["solver"]["resources"]["memory_gib"]=24
                    self.runner.submit({"id":ident,"config":cfg})
                wait_for(lambda:len(entered)==2)
                self.assertEqual(self.runner.jobs["3"*32]["state"],"queued")
                gate.set()
                wait_for(lambda:len(entered)==3 and all(j["state"]=="done" for j in self.runner.jobs.values()))
            finally: gate.set()

    def test_immediate_case_start_requires_free_cpu(self):
        gate = threading.Event()
        def fake(j, cpus):
            gate.wait(3)
            with self.runner.lock:
                j.update(state="done", seconds=.01)
        with patch.object(self.runner, "execute", side_effect=fake):
            try:
                for ident in ("1"*32, "2"*32):
                    self.runner.submit({"id":ident,"config":copy.deepcopy(CONFIG),"require_capacity":True})
                self.assertEqual(sum(j["cpus"] for j in self.runner.jobs.values() if j["state"]=="starting"),4)
                self.assertEqual(self.runner.cpu_capacity(), {"ncpu":4,"free_cpu":0})
                with self.assertRaisesRegex(RuntimeError,"CPU capacity unavailable"):
                    self.runner.submit({"id":"3"*32,"config":copy.deepcopy(CONFIG),"require_capacity":True})
                self.assertNotIn("3"*32,self.runner.jobs)
            finally:
                gate.set()
                for _ in range(200):
                    if all(j["state"]=="done" for j in self.runner.jobs.values()):break
                    time.sleep(.01)
                self.assertEqual(self.runner.cpu_capacity(), {"ncpu":4,"free_cpu":4})

    def test_cpu_budget_and_cancel_queued_job(self):
        gate=threading.Event()
        entered=[]
        def fake(j, cpus):
            with self.runner.lock:
                entered.append(j["id"])
                j["state"]="running"
            gate.wait(3)
            with self.runner.lock:
                j.update(state="done",seconds=.01)
        cfg=copy.deepcopy(CONFIG)
        cfg["solver"]["resources"]={"cpus":4,"memory_gib":24}
        with patch.object(self.runner,"execute",side_effect=fake):
            try:
                self.runner.submit({"id":"1"*32,"config":cfg})
                self.runner.submit({"id":"2"*32,"config":copy.deepcopy(cfg)})
                self.assertEqual(self.runner.jobs["2"*32]["state"],"queued")
                self.runner.cancel(self.runner.jobs["2"*32])
                self.assertEqual(self.runner.jobs["2"*32]["state"],"cancelled")
                gate.set()
                for _ in range(200):
                    if self.runner.jobs["1"*32]["state"]=="done":break
                    time.sleep(.01)
                self.assertEqual(entered,["1"*32])
                self.assertEqual(self.runner.jobs["1"*32]["state"],"done")
            finally:gate.set()

    def test_detached_batch_survives_missing_polls_and_respects_pool(self):
        gate = threading.Event()
        entered = []
        def fake(j, cpus):
            with self.runner.lock:
                j["state"] = "running"
                entered.append(j["id"])
            gate.wait(3)
            with self.runner.lock:
                j.update(state="done", seconds=.01)
        jobs = [{"id": str(n)*32, "config": copy.deepcopy(CONFIG)} for n in (1,2,3)]
        with patch.object(self.runner, "execute", side_effect=fake):
            try:
                self.assertEqual(self.runner.submit_many(jobs, "a"*32, 2), [j["id"] for j in jobs])
                self.assertEqual(self.runner.submit_many(jobs, "a"*32, 2), [j["id"] for j in jobs])
                with self.runner.lock:
                    for j in self.runner.jobs.values():
                        j["last_contact"] -= 86400
                    self.runner.dispatch_locked()
                self.assertEqual(self.runner.jobs["2"*32]["state"], "queued")
                self.assertFalse(self.runner.jobs[ID]["cancel"].is_set())
                gate.set()
                for _ in range(200):
                    if len(entered)==3 and all("finished_at" in j for j in self.runner.jobs.values()):break
                    time.sleep(.01)
                self.assertEqual(entered, [j["id"] for j in jobs])
                self.assertTrue(all(j["state"]=="done" for j in self.runner.jobs.values()))
                restored = Runner(self.args, [], Path(self.temp.name))
                self.assertEqual(len(restored.list_jobs()), 3)
                self.assertTrue(all(j["state"]=="done" for j in restored.list_jobs()))
            finally: gate.set()

    def test_queued_job_recovers_on_restart(self):
        cfg = copy.deepcopy(CONFIG)
        cfg["solver"]["resources"]["cpus"] = 4
        with patch.object(self.runner, "dispatch_locked"):
            self.runner.submit_many([{"id": ID, "config": cfg, "case_key": "test", "case_id": "default"}], "a"*32, 4)
        restored = Runner(self.args, [], Path(self.temp.name))
        self.assertEqual(restored.list_jobs()[0]["state"], "queued")
        self.assertEqual(restored.list_jobs()[0]["case_key"], "test")
        with patch.object(restored, "execute", side_effect=lambda j, cpus: j.update(state="done", seconds=.01)):
            with restored.lock: restored.dispatch_locked()
            for _ in range(200):
                if "finished_at" in restored.jobs[ID]: break
                time.sleep(.01)
            self.assertEqual(restored.jobs[ID]["state"], "done")
            restored.purge(restored.jobs[ID])
        self.assertEqual(Runner(self.args, [], Path(self.temp.name)).list_jobs(), [])

    def test_batch_rejects_all_on_invalid_case(self):
        good = {"id": ID, "config": copy.deepcopy(CONFIG)}
        bad = {"id": "2"*32, "config": {}}
        with self.assertRaises(ValueError):
            self.runner.submit_many([good, bad], "a"*32, 4)
        self.assertEqual(self.runner.jobs, {})

    def test_docker_has_cpu_limit_but_no_memory_limit(self):
        from unittest.mock import MagicMock
        self.args.image="radiators-openems:ci"
        path=Path(self.temp.name)/"job"
        path.mkdir()
        j={"id":ID,"path":path,"state":"starting","cancel":threading.Event(),
           "created":time.monotonic(),"error":None}
        process=MagicMock()
        process.poll.return_value=0
        process.returncode=0
        with patch("remote_runner.subprocess.Popen",return_value=process) as launch:
            self.runner.execute(j,2)
        cmd=launch.call_args.args[0]
        self.assertIn("--cpus=2",cmd)
        self.assertIn("RADIATORS_OPENEMS_THREADS=2",cmd)
        self.assertIn("OPENEMS_ENGINE=cpu",cmd)
        self.assertFalse(any(a.startswith(("--memory","--memory-swap")) for a in cmd))

    def test_api(self):
        def fake(j, cpus):
            path=j["path"]/"out"
            path.mkdir()
            (path/"result.json").write_text(json.dumps({"patterns":[{"file":"pattern_2450000000Hz.json"}]}))
            (path/"pattern_2450000000Hz.json").write_text(json.dumps({"radiation_valid":True}))
            with self.runner.lock:
                j.update(state="done", seconds=.01)
        http=ThreadingHTTPServer(("127.0.0.1",0),Handler)
        http.runner=self.runner
        thread=threading.Thread(target=http.serve_forever,daemon=True)
        thread.start()
        self.addCleanup(http.server_close)
        self.addCleanup(http.shutdown)
        base="http://127.0.0.1:"+str(http.server_port)
        def request(path,method="GET",body=None,token=TOKEN,origin=ORIGIN):
            headers={"Authorization":"Bearer "+token,"Origin":origin}
            if body is not None: headers["Content-Type"]="application/json"
            req=Request(base+path,data=json.dumps(body).encode() if body is not None else None,headers=headers,method=method)
            with urlopen(req,timeout=3) as r:
                self.assertEqual(r.headers["Access-Control-Allow-Origin"],ORIGIN)
                return json.load(r)
        with self.assertRaises(HTTPError) as e:
            request("/v1/health",token="bad")
        self.assertEqual(e.exception.code,403)
        self.assertIn("Invalid bearer token",json.load(e.exception)["error"])
        with self.assertRaises(HTTPError) as e:
            urlopen(base+"/v1/health",timeout=3)
        self.assertIn("Authorization header missing",json.load(e.exception)["error"])
        with self.assertRaises(HTTPError) as e:
            request("/v1/health",origin="https://wrong.example")
        self.assertEqual(json.load(e.exception)["error"],"Origin not allowed by runner")
        self.assertEqual(request("/v1/health")["api_version"],1)
        self.assertEqual(request("/v1/health")["ncpu"],4)
        self.assertEqual(request("/v1/health")["free_cpu"],4)
        self.assertIsNone(request("/v1/health")["lease_timeout"])
        self.assertTrue(request("/v1/health")["detached_jobs"])
        self.assertIs(request("/v1/health")["memory_limit"],False)
        self.assertIsNone(request("/v1/health")["max_memory_gib"])
        self.assertEqual(request("/v1/jobs"),{"jobs":[]})
        with patch.object(self.runner,"execute",side_effect=fake):
            self.assertEqual(request("/v1/jobs","POST",{"id":ID,"config":CONFIG})["id"],ID)
            for _ in range(100):
                if request("/v1/jobs/"+ID)["state"]=="done": break
                time.sleep(.01)
            r=request("/v1/jobs/"+ID+"/result")
            self.assertEqual(r["generator"],"remote native openEMS")
            self.assertTrue(r["patterns"][0]["record"]["radiation_valid"])
            self.assertEqual(request("/v1/jobs")["jobs"][0]["state"], "done")
            for _ in range(200):
                if "finished_at" in self.runner.jobs[ID]: break
                time.sleep(.01)
            self.assertEqual(request("/v1/jobs/"+ID+"/result","DELETE")["deleted"], True)
            self.assertEqual(request("/v1/jobs"), {"jobs":[]})
            batch = {"id":"a"*32,"jobs":[{"id":str(n)*32,"config":CONFIG,"case_id":"case-"+str(n),"case_key":"hash-"+str(n)} for n in (2,3)]}
            self.assertEqual(request("/v1/batches","POST",batch)["ids"],["2"*32,"3"*32])
            self.assertEqual(request("/v1/batches","POST",batch)["ids"],["2"*32,"3"*32])
            for _ in range(200):
                if all("finished_at" in j for j in self.runner.jobs.values()):break
                time.sleep(.01)
            self.assertEqual(len(request("/v1/jobs")["jobs"]),2)
            self.assertTrue(all(j["state"]=="done" for j in request("/v1/jobs")["jobs"]))


if __name__ == "__main__":
    unittest.main()
