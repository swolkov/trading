/**
 * Creates a reproducibility manifest for the local Databento research inputs.
 * The CSVs stay untracked because they are large and licensed; this checked-in
 * manifest pins their hashes, coverage, schema, and continuous-contract IDs.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUTPUT = path.join(ROOT, "research", "databento-manifest.json");
const INPUTS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["data/ES_1m.csv", "data/NQ_1m.csv", "data/gold3y/GC_1m.csv"];

function inspect(relativePath: string) {
  const absolutePath = path.resolve(ROOT, relativePath);
  const body = fs.readFileSync(absolutePath);
  const text = body.toString("utf8").trim();
  const lines = text.split("\n");
  const header = lines[0];
  const first = lines[1]?.split(",");
  const last = lines.at(-1)?.split(",");
  const instrumentIds = new Set<string>();
  for (let index = 1; index < lines.length; index++) {
    const instrumentId = lines[index].split(",", 4)[3];
    if (instrumentId) instrumentIds.add(instrumentId);
  }
  return {
    path: relativePath,
    bytes: body.byteLength,
    sha256: createHash("sha256").update(body).digest("hex"),
    rows: Math.max(0, lines.length - 1),
    firstEvent: first?.[0] ?? null,
    lastEvent: last?.[0] ?? null,
    instrumentIds: [...instrumentIds].sort(),
    header,
  };
}

const manifest = {
  formatVersion: 1,
  provider: "Databento",
  dataset: "GLBX.MDP3",
  schema: "ohlcv-1m",
  stypeIn: "continuous",
  rollPolicy: "volume-ranked v.0; validators require every bar in an indicator window to share one instrument_id and never carry a trade across a roll",
  files: INPUTS.map(inspect),
};

fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
fs.writeFileSync(OUTPUT, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Wrote ${path.relative(ROOT, OUTPUT)} for ${manifest.files.length} files.`);
