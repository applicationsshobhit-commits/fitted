// Usage: node design/export.js <profile.json> [outDir]
// Writes one STL per design (millimetres, ready for a slicer) and params.json
// with every size and the reason behind it.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js';
import { designFromProfile, builtUpGeometry, bulbGeometry, cuffGeometries, volume } from './designs.js';

export function buildAll(profile) {
  const params = designFromProfile(profile);
  const cuff = cuffGeometries(params.cuff);
  return {
    params,
    parts: {
      'built-up-grip': [builtUpGeometry(params.builtUp)],
      'universal-cuff': [cuff.bandGeo, cuff.pocketGeo],
      'palm-bulb': [bulbGeometry(params.bulb)],
    },
  };
}

export function measure(geos) {
  const box = new THREE.Box3();
  for (const g of geos) { g.computeBoundingBox(); box.union(g.boundingBox); }
  const s = box.getSize(new THREE.Vector3());
  return {
    sizeMm: [s.x, s.y, s.z].map(v => Math.round(v * 10) / 10),
    volumeCm3: Math.round(geos.reduce((sum, g) => sum + volume(g), 0) / 100) / 10,
  };
}

function writeStl(geos, file) {
  const group = new THREE.Group();
  for (const g of geos) group.add(new THREE.Mesh(g));
  const data = new STLExporter().parse(group, { binary: true });
  writeFileSync(file, Buffer.from(data.buffer));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [profilePath, outArg] = process.argv.slice(2);
  if (!profilePath) {
    console.error('usage: node design/export.js <profile.json> [outDir]');
    process.exit(1);
  }
  const outDir = outArg || join(dirname(fileURLToPath(import.meta.url)), 'out');
  mkdirSync(outDir, { recursive: true });
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  const { params, parts } = buildAll(profile);
  const report = {};
  for (const [name, geos] of Object.entries(parts)) {
    writeStl(geos, join(outDir, `${name}.stl`));
    report[name] = measure(geos);
  }
  writeFileSync(join(outDir, 'params.json'), JSON.stringify({ profile, params, report }, null, 2));
  if (params.estimated) console.warn('Sizes are estimated: the profile was not calibrated.');
  console.table(Object.fromEntries(Object.entries(report).map(([k, v]) => [k, { 'size (mm)': v.sizeMm.join(' × '), 'volume (cm³)': v.volumeCm3 }])));
  console.log(`Wrote STL files and params.json to ${outDir}`);
}
