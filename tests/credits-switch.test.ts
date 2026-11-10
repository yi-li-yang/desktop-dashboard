// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { creditsView, type CreditsInput } from "../src/cards/credits-switch.ts";

const eu = (over: Partial<CreditsInput>): CreditsInput => ({
  is_enabled: true,
  monthly_limit: 10,
  used: 9,
  spend_limit_reached: false,
  ...over,
});

test("no data shows nothing", () => {
  assert.equal(creditsView(null, 2), null);
});

test("off offers to turn on at spent + allowance", () => {
  const v = creditsView(eu({ is_enabled: false, used: 4.5 }), 2)!;
  assert.equal(v.tone, "off");
  assert.equal(v.action?.label, "Turn on for $2.00");
  assert.equal(v.action?.target, 6.5);
});

test("off with unknown spend still offers the switch, without a number", () => {
  const v = creditsView(eu({ is_enabled: false, used: null }), 2)!;
  assert.equal(v.tone, "off");
  assert.equal(v.action?.target, null);
  assert.match(v.detail, /this month's spend \+ \$2\.00/);
});

test("on within the allowance needs nothing", () => {
  const v = creditsView(eu({ monthly_limit: 10, used: 8.5 }), 2)!;
  assert.equal(v.tone, "on");
  assert.equal(v.label, "On · $1.50 left");
  assert.equal(v.action, null);
  assert.equal(creditsView(eu({ monthly_limit: 10, used: 8 }), 2)!.tone, "on");
});

test("limit reached offers another round", () => {
  const v = creditsView(eu({ monthly_limit: 10, used: 10, spend_limit_reached: true }), 2)!;
  assert.equal(v.tone, "spent");
  assert.equal(v.action?.target, 12);
  assert.equal(creditsView(eu({ monthly_limit: 10, used: 9.999 }), 2)!.tone, "spent");
});

test("more open than the allowance is loose, as after the monthly reset", () => {
  const v = creditsView(eu({ monthly_limit: 40, used: 0 }), 2)!;
  assert.equal(v.tone, "loose");
  assert.equal(v.label, "On · $40.00 open");
  assert.equal(v.action?.target, 2);
});

test("on with no monthly limit is flagged", () => {
  const v = creditsView(eu({ monthly_limit: null, used: 3.456 }), 2)!;
  assert.equal(v.tone, "none");
  assert.equal(v.action?.target, 5.46);
});

test("allowance size is respected", () => {
  assert.equal(creditsView(eu({ monthly_limit: 10, used: 5 }), 5)!.tone, "on");
  assert.equal(creditsView(eu({ monthly_limit: 10, used: 5 }), 1)!.tone, "loose");
});
