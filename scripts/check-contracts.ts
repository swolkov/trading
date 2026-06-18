#!/usr/bin/env tsx
import { findContract } from "@/lib/tradovate";

async function main() {
  for (const mode of ["paper", "live"] as const) {
    console.log(`\n=== ${mode.toUpperCase()} ===`);
    for (const sym of ["NQ", "MNQ", "ES", "MES"]) {
      try {
        const c = await findContract(sym, mode);
        console.log(`  ${sym}: ${c ? `#${c.id} ${c.name} tick=${c.tickSize}` : "NOT FOUND"}`);
      } catch (e) { console.log(`  ${sym}: ERROR — ${e}`); }
    }
  }
}
main().catch(console.error);
