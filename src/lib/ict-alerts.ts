// ICT SETUPS → SLACK — I/O. Records each ACTION change the ICT Setups indicator posts (raw SQL table, so a schema
// push can never drop it; the id makes a TradingView retry a no-op) and posts it to #futures-copilot. No order path.
import { prisma } from "@/lib/db";
import { sendNotification } from "@/lib/notifications";
import { ictText, type IctAlert } from "@/lib/ict-alert-rules";

export async function ensureIctTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS trading_room_ict_alerts (
    id text PRIMARY KEY, symbol text NOT NULL, tf text NOT NULL, action text NOT NULL, side int NOT NULL,
    entry float8 NOT NULL, stop float8 NOT NULL, tp1 float8, bar timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now())`);
}

/** Store and announce. A retry of the same bar + action is a duplicate and says nothing. */
export async function recordIctAlert(a: IctAlert): Promise<{ duplicate: boolean }> {
  await ensureIctTable();
  const rows = await prisma.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO trading_room_ict_alerts (id, symbol, tf, action, side, entry, stop, tp1, bar) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (id) DO NOTHING RETURNING id`,
    a.id, a.symbol, a.tf, a.action, a.side, a.entry, a.stop, a.tp1, new Date(a.bar),
  );
  if (!rows.length) return { duplicate: true };
  await sendNotification(ictText(a), "copilot", undefined, { noUnfurl: true }).catch(() => {});
  return { duplicate: false };
}
