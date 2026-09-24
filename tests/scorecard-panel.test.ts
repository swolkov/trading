import { test } from "node:test";
import assert from "node:assert/strict";
import { recapBody } from "../src/components/trading-room/scorecard-panel";
import { botRecapText } from "../src/lib/paper-bot-rules";
import { disciplineRecapText, gradesRecapText } from "../src/lib/trade-grades-rules";

test("scorecard strips the Slack emoji + label but keeps 'today'", () => {
  const g = gradesRecapText([{ grade: "A", netUsd: 120 }], [{ grade: "A", netUsd: 120 }])!;
  assert.ok(recapBody(g).startsWith("today: A 1 trade +$120"), recapBody(g));
  const d = disciplineRecapText([{ score: 6, netUsd: -50 }], [{ score: 6, netUsd: -50 }])!;
  assert.ok(recapBody(d).startsWith("today: by the book 1 trade −$50"), recapBody(d));
  const b = botRecapText([{ status: "done", usd: 80 }], [{ status: "done", usd: 80 }], null);
  assert.ok(recapBody(b).startsWith("today: 1 trades +$80"), recapBody(b));
});
