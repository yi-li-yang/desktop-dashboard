// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { fuseView, type FuseInput } from "../src/cards/fuse.ts";

const eu = (over: Partial<FuseInput>): FuseInput => ({
  is_enabled: true,
  monthly_limit: 10,
  used: 9,
  spend_limit_reached: false,
  ...over,
});

test("no data shows nothing", () => {
  assert.equal(fuseView(null, 2), null);
});

test("credits off needs no fuse", () => {
  const v = fuseView(eu({ is_enabled: false }), 2)!;
  assert.equal(v.tone, "off");
  assert.equal(v.target, null);
});

test("no monthly limit suggests spent + fuse", () => {
  const v = fuseView(eu({ monthly_limit: null, used: 3.456 }), 2)!;
  assert.equal(v.tone, "none");
  assert.equal(v.target, 5.46);
});

test("headroom within the fuse is armed", () => {
  const v = fuseView(eu({ monthly_limit: 10, used: 8.5 }), 2)!;
  assert.equal(v.tone, "armed");
  assert.match(v.detail, /\$1\.50 more/);
  assert.equal(v.target, null);
  assert.equal(fuseView(eu({ monthly_limit: 10, used: 8 }), 2)!.tone, "armed");
});

test("limit reached is blown and suggests one more fuse", () => {
  const v = fuseView(eu({ monthly_limit: 10, used: 10, spend_limit_reached: true }), 2)!;
  assert.equal(v.tone, "blown");
  assert.equal(v.target, 12);
  assert.equal(fuseView(eu({ monthly_limit: 10, used: 9.999 }), 2)!.tone, "blown");
});

test("too much headroom is loose, which is also the new-month case", () => {
  const v = fuseView(eu({ monthly_limit: 40, used: 0 }), 2)!;
  assert.equal(v.tone, "loose");
  assert.match(v.detail, /\$40\.00/);
  assert.equal(v.target, 2);
});

test("fuse size is respected", () => {
  assert.equal(fuseView(eu({ monthly_limit: 10, used: 5 }), 5)!.tone, "armed");
  assert.equal(fuseView(eu({ monthly_limit: 10, used: 5 }), 1)!.tone, "loose");
});
