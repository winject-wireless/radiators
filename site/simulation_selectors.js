/* Two-level simulation/case selection. Shared by the viewer and its Node tests.
 * Never derive the Simulation menu from the legacy flat "runs" array.
 */
(function (root) {
 "use strict";

 function readSimulations(manifest) {
  if (!manifest || manifest.schema_version !== 2 ||
      !Array.isArray(manifest.simulations)) {
   throw Error("Viewer requires grouped simulation manifest v2");
  }
  const ids = new Set(), paths = new Set();
  return manifest.simulations.map(sim => {
   if (!sim || typeof sim.id !== "string" || !sim.id ||
       typeof sim.name !== "string" || !sim.name ||
       !Array.isArray(sim.cases) || !sim.cases.length) {
    throw Error("Invalid simulation group in manifest");
   }
   if (ids.has(sim.id)) throw Error("Duplicate simulation ID: " + sim.id);
   ids.add(sim.id);
   if (!sim.sweep && sim.cases.length !== 1) {
    throw Error("A non-sweep simulation must have exactly one default case: " + sim.id);
   }
   const caseIds = new Set();
   const cases = sim.cases.map(item => {
    if (!item || typeof item.id !== "string" || !item.id ||
        typeof item.path !== "string" ||
        !/^data\/[A-Za-z0-9_-]+\/result\.json$/.test(item.path)) {
     throw Error("Invalid case for simulation " + sim.id);
    }
    if (caseIds.has(item.id) || paths.has(item.path)) {
     throw Error("Duplicate case ID or result path in " + sim.id);
    }
    caseIds.add(item.id);
    paths.add(item.path);
    return { id: item.id, name: item.name || item.id,
             path: item.path, parameters: item.parameters || {} };
   });
   return { id: sim.id, name: sim.name, sweep: !!sim.sweep, cases };
  });
 }

 function casesForSimulation(simulations, simulationId) {
  const group = simulations.find(item => item.id === simulationId);
  return group ? group.cases : [];
 }

 const api = Object.freeze({readSimulations, casesForSimulation});
 if (typeof module !== "undefined" && module.exports) module.exports = api;
 if (root) root.RadiatorsSelectors = api;
})(typeof window !== "undefined" ? window : null);
