import { getCryptoSnapshots, DEFAULT_CRYPTO_SYMBOLS } from "@/lib/alpaca";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const symbolsParam = searchParams.get("symbols");
    const symbols = symbolsParam ? symbolsParam.split(",") : DEFAULT_CRYPTO_SYMBOLS;

    const snapshots = await getCryptoSnapshots(symbols);

    return Response.json({ snapshots });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
