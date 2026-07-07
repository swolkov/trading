import fs from "node:fs";
const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const KEY = env.match(/^DATABENTO_API_KEY=(.+)$/m)![1].trim();
const auth = "Basic " + Buffer.from(KEY + ":").toString("base64");
const SYMS = ["SI","PL","PA","CL","NG"];
(async () => {
  for (const base of SYMS) {
    process.stdout.write(`fetching ${base}... `);
    try {
      const body = new URLSearchParams({ dataset:"GLBX.MDP3", symbols:`${base}.v.0`, stype_in:"continuous", schema:"ohlcv-1m", start:"2023-05-22", end:"2026-05-21", encoding:"csv", pretty_px:"true", pretty_ts:"true" });
      const res = await fetch("https://hist.databento.com/v0/timeseries.get_range", { method:"POST", headers:{Authorization:auth,"Content-Type":"application/x-www-form-urlencoded"}, body });
      if(!res.ok){console.log(`ERROR ${res.status}: ${(await res.text()).slice(0,100)}`);continue;}
      const csv = await res.text();
      fs.writeFileSync(new URL(`../data/${base}_1m.csv`, import.meta.url), csv);
      const rows = csv.trim().split("\n");
      console.log(`${rows.length-1} bars`);
    } catch(e){console.log(`EXCEPTION ${(e as Error).message.slice(0,100)}`);}
  }
  console.log("done");
})();
