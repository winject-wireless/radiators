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
        self.args = SimpleNamespace(max_cpus=4,max_memory_gib=4,max_cells=10000,
            max_timesteps=100000,retain=2,token=TOKEN,origin=[ORIGIN])
        self.runner = Runner(self.args, [], Path(self.temp.name))

    def test_private_config(self):
        path = Path(self.temp.name)/"settings"/"config.json"
        a = load_config(path)
        self.assertEqual(a,load_config(path))
        self.assertEqual(path.stat().st_mode & 0o777,0o600)
        self.assertNotIn(a["token"],server_command(a))

    def test_limits(self):
        cfg=copy.deepcopy(CONFIG)
        self.assertEqual(validate({"id":ID,"config":cfg},self.args)[2:],(2,1024**3))
        cfg["solver"]["resources"]["cpus"]=5
        with self.assertRaises(ValueError): validate({"id":ID,"config":cfg},self.args)
        cfg=copy.deepcopy(CONFIG)
        cfg["scripts"]={}
        with self.assertRaises(ValueError): validate({"id":ID,"config":cfg},self.args)

    def test_parallel_cpu_and_memory_budget(self):
        gate=threading.Event()
        entered=[]
        def fake(j, cpus, memory):
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
                    self.runner.submit({"id":ident,"config":copy.deepcopy(CONFIG)})
                wait_for(lambda:len(entered)==2)
                self.assertEqual(self.runner.jobs["3"*32]["state"],"queued")
                gate.set()
                wait_for(lambda:len(entered)==3 and all(j["state"]=="done" for j in self.runner.jobs.values()))
            finally: gate.set()

    def test_memory_budget_and_cancel_queued_job(self):
        gate=threading.Event()
        entered=[]
        def fake(j, cpus, memory):
            with self.runner.lock:
                entered.append(j["id"])
                j["state"]="running"
            gate.wait(3)
            with self.runner.lock:
                j.update(state="done",seconds=.01)
        cfg=copy.deepcopy(CONFIG)
        cfg["solver"]["resources"]={"cpus":1,"memory_gib":3}
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

    def test_expired_leases_cancel_running_and_queued(self):
        entered = threading.Event()
        def fake(j, cpus, memory):
            with self.runner.lock:
                j["state"] = "running"
            entered.set()
            j["cancel"].wait(3)
            with self.runner.lock:
                j.update(state="cancelled", seconds=.01)
        cfg = copy.deepcopy(CONFIG)
        cfg["solver"]["resources"]["cpus"] = 4
        with patch.object(self.runner, "execute", side_effect=fake):
            self.runner.submit({"id":ID,"config":copy.deepcopy(cfg)})
            self.assertTrue(entered.wait(2))
            self.runner.submit({"id":"2"*32,"config":copy.deepcopy(cfg)})
            self.runner.submit({"id":"3"*32,"config":copy.deepcopy(cfg)})
            with self.runner.lock:
                for j in self.runner.jobs.values():
                    j["last_contact"] -= self.runner.lease_timeout+1
            self.runner.snapshot(self.runner.jobs["3"*32])
            self.assertEqual(len(self.runner.list_jobs()),3)
            self.runner.expire_leases()
            self.assertTrue(self.runner.jobs[ID]["cancel"].is_set())
            self.assertEqual(self.runner.jobs["2"*32]["state"],"cancelled")
            self.assertEqual(self.runner.jobs["2"*32]["error"],"Client lease expired")
            self.assertFalse(self.runner.jobs["3"*32]["cancel"].is_set())
            self.runner.cancel(self.runner.jobs["3"*32])
            for _ in range(200):
                if all(j["state"]=="cancelled" for j in self.runner.jobs.values()):break
                time.sleep(.01)
            self.assertTrue(all(j["state"]=="cancelled" for j in self.runner.jobs.values()))

    def test_api(self):
        def fake(j, cpus, memory):
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
        self.assertEqual(request("/v1/health")["lease_timeout"],300)
        self.assertEqual(request("/v1/jobs"),{"jobs":[]})
        with patch.object(self.runner,"execute",side_effect=fake):
            self.assertEqual(request("/v1/jobs","POST",{"id":ID,"config":CONFIG})["id"],ID)
            for _ in range(100):
                if request("/v1/jobs/"+ID)["state"]=="done": break
                time.sleep(.01)
            r=request("/v1/jobs/"+ID+"/result")
            self.assertEqual(r["generator"],"remote native openEMS")
            self.assertTrue(r["patterns"][0]["record"]["radiation_valid"])


if __name__ == "__main__":
    unittest.main()
