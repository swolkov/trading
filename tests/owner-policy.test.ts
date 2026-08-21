import assert from "node:assert/strict";
import test from "node:test";
import { evaluateOwnerAuthorization } from "../src/auth/owner-policy";

test("owner authorization accepts only the configured Clerk user", () => {
  assert.equal(evaluateOwnerAuthorization("user_owner", "user_owner"), "authorized");
  assert.equal(evaluateOwnerAuthorization("user_other", "user_owner"), "forbidden");
});

test("owner authorization fails closed without a session or owner configuration", () => {
  assert.equal(evaluateOwnerAuthorization(null, "user_owner"), "unauthenticated");
  assert.equal(evaluateOwnerAuthorization("user_owner", undefined), "misconfigured");
  assert.equal(evaluateOwnerAuthorization("user_owner", "   "), "misconfigured");
});

test("owner authorization trims accidental whitespace from the configured ID", () => {
  assert.equal(evaluateOwnerAuthorization("user_owner", "  user_owner  "), "authorized");
});
