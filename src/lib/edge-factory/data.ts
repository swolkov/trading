import fs from "node:fs";
import type { ResearchBar } from "./types";

export function loadDatabentoCsv(path: string): ResearchBar[] {
  const lines = fs.readFileSync(path, "utf8").trim().split("\n");
  const header = lines[0].split(",");
  const column = (name: string) => header.indexOf(name);
  const indexes = {
    t: column("ts_event"), instrument: column("instrument_id"), o: column("open"),
    h: column("high"), l: column("low"), c: column("close"), v: column("volume"),
  };
  if (Object.values(indexes).some((value) => value < 0)) throw new Error(`Unsupported Databento CSV schema: ${path}`);
  const bars: ResearchBar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split(",");
    const bar = {
      t: new Date(fields[indexes.t]).getTime(), instrumentId: fields[indexes.instrument],
      o: Number(fields[indexes.o]), h: Number(fields[indexes.h]), l: Number(fields[indexes.l]),
      c: Number(fields[indexes.c]), v: Number(fields[indexes.v]) || 0,
    };
    if (Number.isFinite(bar.t) && bar.c > 0) bars.push(bar);
  }
  return bars.sort((a, b) => a.t - b.t);
}

export function aggregateBars(bars: readonly ResearchBar[], minutes: number): ResearchBar[] {
  const width = minutes * 60_000;
  const result: ResearchBar[] = [];
  let current: ResearchBar | null = null;
  let currentBucket = -1;
  for (const bar of bars) {
    const bucket = Math.floor(bar.t / width) * width;
    if (!current || bucket !== currentBucket || current.instrumentId !== bar.instrumentId) {
      current = { ...bar, t: bucket };
      result.push(current);
      currentBucket = bucket;
    } else {
      current.h = Math.max(current.h, bar.h);
      current.l = Math.min(current.l, bar.l);
      current.c = bar.c;
      current.v += bar.v;
    }
  }
  return result;
}
