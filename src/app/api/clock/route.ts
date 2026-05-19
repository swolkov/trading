// Futures market clock — Sunday 6 PM ET through Friday 5 PM ET
// Daily maintenance break: 5 PM - 6 PM ET (Mon-Thu)

function getETNow(): { day: number; hour: number; minute: number; second: number } {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short", hour: "numeric", minute: "numeric", second: "numeric", hour12: false,
  }).formatToParts(now);
  const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const day = dayMap[parts.find(p => p.type === "weekday")?.value || "Mon"] ?? 1;
  const hour = parseInt(parts.find(p => p.type === "hour")?.value || "0");
  const minute = parseInt(parts.find(p => p.type === "minute")?.value || "0");
  const second = parseInt(parts.find(p => p.type === "second")?.value || "0");
  return { day, hour, minute, second };
}

function etToUTC(daysFromNow: number, hour: number, minute: number): Date {
  // Build a target date in ET, convert to UTC
  const now = new Date();
  const target = new Date(now.getTime() + daysFromNow * 86400000);
  // Use a reference point: find the UTC offset for ET on the target date
  const etStr = target.toLocaleString("en-US", { timeZone: "America/New_York" });
  const etDate = new Date(etStr);
  const utcOffset = target.getTime() - etDate.getTime(); // ms difference
  // Set the target time in ET
  etDate.setHours(hour, minute, 0, 0);
  // Convert back to UTC
  return new Date(etDate.getTime() + utcOffset);
}

export async function GET() {
  try {
    const { day, hour, minute } = getETNow();
    const timeDecimal = hour + minute / 60;

    let is_open = false;
    let next_open: Date;
    let next_close: Date;

    if (day === 0) {
      if (timeDecimal >= 18) {
        is_open = true;
        next_close = etToUTC(1, 17, 0); // Monday 5 PM ET
        next_open = next_close;
      } else {
        is_open = false;
        next_open = etToUTC(0, 18, 0); // Sunday 6 PM ET
        next_close = etToUTC(1, 17, 0);
      }
    } else if (day === 6) {
      is_open = false;
      next_open = etToUTC(1, 18, 0); // Sunday 6 PM ET
      next_close = etToUTC(2, 17, 0); // Monday 5 PM ET
    } else if (day === 5) {
      if (timeDecimal < 17) {
        is_open = true;
        next_close = etToUTC(0, 17, 0); // Friday 5 PM ET
        next_open = next_close;
      } else {
        is_open = false;
        next_open = etToUTC(2, 18, 0); // Sunday 6 PM ET
        next_close = etToUTC(3, 17, 0);
      }
    } else {
      // Mon-Thu
      if (timeDecimal >= 18) {
        is_open = true;
        next_close = etToUTC(1, 17, 0); // Next day 5 PM ET
        next_open = next_close;
      } else if (timeDecimal >= 17) {
        is_open = false;
        next_open = etToUTC(0, 18, 0); // Today 6 PM ET
        next_close = etToUTC(1, 17, 0);
      } else {
        is_open = true;
        next_close = etToUTC(0, 17, 0); // Today 5 PM ET
        next_open = next_close;
      }
    }

    return Response.json({
      is_open,
      next_open: next_open!.toISOString(),
      next_close: next_close!.toISOString(),
    });
  } catch (error) {
    console.error("[/api/clock]", error);
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
