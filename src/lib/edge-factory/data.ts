import fs from "node:fs";
import type { ResearchBar } from "./types";

/**
 * Reads a large CSV without materialising it as one string.
 *
 * Node cannot return a string longer than ~512MB (ERR_STRING_TOO_LONG). The 15-year one-minute
 * series (`data/tf15y`) are 350-560MB each, so readFileSync(path, "utf8") threw before parsing a
 * single bar. Decoding chunk-by-chunk at newline boundaries keeps peak memory near one chunk and
 * removes the file-size ceiling; the carry preserves rows split across chunks.
 * (Ported from `codex/trading-safety-parity`; here each row is parsed as it streams instead of being
 * collected into a second five-million-string array first.)
 */
function readLinesChunked(file: string, onLine: (row: string) => void): void {
  const CHUNK = 64 * 1024 * 1024;
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.allocUnsafe(CHUNK);
    let position = 0;
    let carry = "";
    while (position < size) {
      const read = fs.readSync(fd, buffer, 0, Math.min(CHUNK, size - position), position);
      if (read <= 0) break;
      position += read;
      let end = read;
      while (end > 0 && buffer[end - 1] !== 0x0a) end--;
      const text = carry + buffer.toString("utf8", 0, end);
      carry = buffer.toString("utf8", end, read);
      let start = 0;
      for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", start)) {
        onLine(text.slice(start, i));
        start = i + 1;
      }
      if (start < text.length) carry = text.slice(start) + carry;
    }
    if (carry.trim()) onLine(carry);
  } finally {
    fs.closeSync(fd);
  }
}

export function loadDatabentoCsv(path: string): ResearchBar[] {
  let indexes: { t: number; instrument: number; o: number; h: number; l: number; c: number; v: number } | null = null;
  const bars: ResearchBar[] = [];
  readLinesChunked(path, (row) => {
    if (!row) return;
    if (!indexes) {
      const header = row.split(",");
      const column = (name: string) => header.indexOf(name);
      indexes = {
        t: column("ts_event"), instrument: column("instrument_id"), o: column("open"),
        h: column("high"), l: column("low"), c: column("close"), v: column("volume"),
      };
      if (Object.values(indexes).some((value) => value < 0)) throw new Error(`Unsupported Databento CSV schema: ${path}`);
      return;
    }
    const fields = row.split(",");
    const bar = {
      t: new Date(fields[indexes.t]).getTime(), instrumentId: fields[indexes.instrument],
      o: Number(fields[indexes.o]), h: Number(fields[indexes.h]), l: Number(fields[indexes.l]),
      c: Number(fields[indexes.c]), v: Number(fields[indexes.v]) || 0,
    };
    if (Number.isFinite(bar.t) && bar.c > 0) bars.push(bar);
  });
  if (!indexes) throw new Error(`Empty CSV: ${path}`);
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
