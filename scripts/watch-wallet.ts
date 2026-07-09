// Poll the meme wallet until SOL arrives, then report.
const ADDR = "6zuN2EhbayTqbBrQrMxgyKKMR4XZsnT8LQWJDpLm61SM";
async function bal(): Promise<number> {
  try {
    const r = await fetch("https://api.mainnet-beta.solana.com", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [ADDR] }), signal: AbortSignal.timeout(12000) });
    const d = await r.json(); return (d.result?.value || 0) / 1e9;
  } catch { return 0; }
}
(async () => {
  for (let i = 0; i < 40; i++) {   // ~2h at 3-min intervals
    const s = await bal();
    if (s > 0) { console.log(`FUNDED: ${s} SOL (~$${(s * 77).toFixed(0)}) arrived in the meme wallet.`); process.exit(0); }
    await new Promise((r) => setTimeout(r, 180000));
  }
  console.log("still empty after ~2h — check Kraken withdrawal status"); process.exit(2);
})();
