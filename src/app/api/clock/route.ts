// Futures market clock — Sunday 6 PM ET through Friday 5 PM ET
// Daily maintenance break: 5 PM - 6 PM ET (Mon-Thu)

export async function GET() {
  try {
    const now = new Date();
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const day = et.getDay(); // 0=Sun, 6=Sat
    const hour = et.getHours();
    const minute = et.getMinutes();
    const timeDecimal = hour + minute / 60;

    let is_open = false;
    let next_open: Date;
    let next_close: Date;

    // Futures schedule (ET):
    // Open:  Sunday 6 PM → Friday 5 PM
    // Break: Mon-Thu 5 PM → 6 PM (1 hour daily)
    // Closed: Friday 5 PM → Sunday 6 PM

    if (day === 0) {
      // Sunday
      if (timeDecimal >= 18) {
        // After 6 PM — futures are open
        is_open = true;
        // Next close: Monday 5 PM ET
        next_close = new Date(et);
        next_close.setDate(et.getDate() + 1);
        next_close.setHours(17, 0, 0, 0);
        next_open = next_close; // already open
      } else {
        // Before 6 PM — closed, waiting for Sunday open
        is_open = false;
        next_open = new Date(et);
        next_open.setHours(18, 0, 0, 0);
        next_close = new Date(next_open);
        next_close.setDate(next_close.getDate() + 1);
        next_close.setHours(17, 0, 0, 0);
      }
    } else if (day === 6) {
      // Saturday — closed all day
      is_open = false;
      next_open = new Date(et);
      next_open.setDate(et.getDate() + 1); // Sunday
      next_open.setHours(18, 0, 0, 0);
      next_close = new Date(next_open);
      next_close.setDate(next_close.getDate() + 1);
      next_close.setHours(17, 0, 0, 0);
    } else if (day === 5) {
      // Friday
      if (timeDecimal < 17) {
        // Before 5 PM — open
        is_open = true;
        next_close = new Date(et);
        next_close.setHours(17, 0, 0, 0);
        next_open = next_close;
      } else {
        // After 5 PM — closed for weekend
        is_open = false;
        next_open = new Date(et);
        next_open.setDate(et.getDate() + 2); // Sunday
        next_open.setHours(18, 0, 0, 0);
        next_close = new Date(next_open);
        next_close.setDate(next_close.getDate() + 1);
        next_close.setHours(17, 0, 0, 0);
      }
    } else {
      // Mon-Thu
      if (timeDecimal >= 18) {
        // After 6 PM — open (evening session)
        is_open = true;
        next_close = new Date(et);
        next_close.setDate(et.getDate() + 1);
        next_close.setHours(17, 0, 0, 0);
        next_open = next_close;
      } else if (timeDecimal >= 17) {
        // 5-6 PM — daily maintenance break
        is_open = false;
        next_open = new Date(et);
        next_open.setHours(18, 0, 0, 0);
        next_close = new Date(next_open);
        next_close.setDate(next_close.getDate() + 1);
        next_close.setHours(17, 0, 0, 0);
      } else {
        // Before 5 PM — open
        is_open = true;
        next_close = new Date(et);
        next_close.setHours(17, 0, 0, 0);
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
    return Response.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
