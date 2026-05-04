import { getAccount } from "@/lib/alpaca";

export async function GET() {
  try {
    const account = await getAccount();
    return Response.json(account);
  } catch (error) {
    console.error("[/api/account]", error);
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
