import { detectCryptoRegime, getFearAndGreed, getCryptoGlobal, scanCryptoSetups } from "@/lib/crypto-research";
import { DEFAULT_CRYPTO_SYMBOLS } from "@/lib/alpaca";

export async function GET() {
  try {
    const [regime, fearGreed, global] = await Promise.all([
      detectCryptoRegime(),
      getFearAndGreed(),
      getCryptoGlobal(),
    ]);

    // Scan for setups using detected regime
    const setups = await scanCryptoSetups(DEFAULT_CRYPTO_SYMBOLS, regime.regime);

    return Response.json({
      regime: regime.regime,
      regimeDetails: regime.details,
      fearGreed,
      global,
      btcRsi: regime.btcRsi,
      btcTrend: regime.btcTrend,
      setups: setups.map((s) => ({
        symbol: s.symbol,
        type: s.type,
        direction: s.direction,
        price: s.price,
        stopPrice: s.stopPrice,
        targetPrice: s.targetPrice,
        riskReward: s.riskReward,
        confidence: s.confidence,
        reasoning: s.reasoning,
      })),
    });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
