#!/usr/bin/env node
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const editor = require("./editor.js");

const baseline = editor.normalizeConfig(editor.initial);
assert.equal(baseline.schema_version, 2);
assert.equal(baseline.geometry.length, 2);
assert.equal(baseline.geometry[0].name, "Ground disk");
assert.equal(baseline.ports[0].impedance_ohm, 50);
assert.ok(baseline.geometry.every(x => x.editor_id));

const withDuplicates = editor.normalizeConfig({
  schema_version: 2, name: "duplicates", materials: [{ name: "metal", type: "pec" }],
  geometry: [
    { name: "dipole", shape: "cylinder", editor_id: "one" },
    { name: "dipole", shape: "cylinder", editor_id: "one" }
  ]
});
assert.equal(withDuplicates.geometry[0].name, "dipole");
assert.equal(withDuplicates.geometry[1].name, "dipole 2");
assert.notEqual(withDuplicates.geometry[0].editor_id, withDuplicates.geometry[1].editor_id);

assert.equal(editor.helixPoints({
  origin: [0, 0, 0], axis: [0, 0, 1], diameter: 20, height: 20,
  turns: 1, segments_per_turn: 16
}).length, 17);

const source = editor.buildJscadSource(baseline);
assert.match(source, /const config = /);
assert.match(source, /Ground disk/);
assert.match(source, /const degrees = /);
assert.doesNotThrow(() => new vm.Script(source, { filename: "antenna-draft.jscad" }));

const built = process.argv[2];
if (built) {
  const kernel = require(path.resolve(built, "jscad-modeling.min.js"));
  assert.equal(typeof kernel.primitives.cylinder, "function");
  assert.equal(typeof kernel.geometries.geom3.toPolygons, "function");
  for (const g of baseline.geometry) {
    const solids = editor.componentSolids(g, kernel);
    assert.ok(solids.length > 0);
    assert.ok(solids.every(s => kernel.geometries.geom3.toPolygons(s).length > 0));
  }
  const context = { require: id => {
    assert.equal(id, "@jscad/modeling");
    return kernel;
  }, module: { exports: {} }, Math };
  vm.runInNewContext(source, context, { filename: "antenna-draft.jscad" });
  assert.equal(context.module.exports.main().length, 2);
}
const yagiPath = path.resolve(__dirname,
  "../antennas/yagi_16rod_bonded_boom_measured_loop_best_p24_f24_b36_y14_fine_2450.json");
if (fs.existsSync(yagiPath)) {
  const yagi = editor.normalizeConfig(JSON.parse(fs.readFileSync(yagiPath, "utf8")));
  assert.ok(yagi.geometry.length >= 18);
  assert.ok(yagi.geometry.some(g => g.name === "square-aluminum-boom-bonded"));
  assert.ok(yagi.geometry.some(g => g.name === "director-01"));
}
console.log("Antenna editor models, names, JSON, and generated JSCAD: OK");
