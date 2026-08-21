import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isPublicPath } from "../src/lib/route-access";

test("only intended investor and cron paths are public", () => {
  for (const pathname of ["/sign-in", "/fund", "/proof", "/api/fund/stats", "/api/cron/futures"]) {
    assert.equal(isPublicPath(pathname), true, pathname);
  }
});

test("all futures trading and accounting paths are private", () => {
  for (const pathname of [
    "/api/futures",
    "/api/futures/positions",
    "/api/futures/close",
    "/api/futures/cleanup",
    "/api/futures/backfill",
    "/api/futures/capital-flows",
    "/api/admin/strategy-toggle",
  ]) {
    assert.equal(isPublicPath(pathname), false, pathname);
  }
});

test("lookalike prefixes do not become public", () => {
  assert.equal(isPublicPath("/proofreader"), false);
  assert.equal(isPublicPath("/funding"), false);
  assert.equal(isPublicPath("/api/funder/stats"), false);
});

test("web recovery and manual checks cannot invoke the legacy broker manager", () => {
  const manualRoute = readFileSync(new URL("../src/app/api/futures/route.ts", import.meta.url), "utf8");
  const cronRoute = readFileSync(new URL("../src/app/api/cron/futures/route.ts", import.meta.url), "utf8");

  assert.doesNotMatch(manualRoute, /runFuturesAgent/);
  assert.equal(cronRoute.match(/runFuturesAgent\(/g)?.length, 1);
  assert.match(cronRoute, /runFuturesAgent\(\{ registryOnly: true \}\)/);
  assert.doesNotMatch(cronRoute, /managementOnly/);
});
