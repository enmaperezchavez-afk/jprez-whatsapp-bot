// ============================================
// Tests Hotfix-31 — safeEqual + cron auth fail-closed
// ============================================
// safeEqual: comparación timing-safe de secretos (src/security/safe-compare.js).
// isAuthorized de followup: mismo contrato fail-closed que api/icdv.js
// (ese ya se cubre en icdv-endpoint.test.mjs).

import { describe, it, expect } from "vitest";
import { safeEqual } from "../src/security/safe-compare.js";
import followupHandler from "../api/followup.js";

describe("safeEqual (Hotfix-31)", () => {
  it("true para strings idénticos", () => {
    expect(safeEqual("s3cr3t", "s3cr3t")).toBe(true);
    expect(safeEqual("Bearer abc", "Bearer abc")).toBe(true);
  });

  it("false para strings distintos (incluye largo distinto)", () => {
    expect(safeEqual("s3cr3t", "s3cr3x")).toBe(false);
    expect(safeEqual("s3cr3t", "s3cr3t-extra")).toBe(false);
    expect(safeEqual("a", "b")).toBe(false);
  });

  it("false para vacíos y no-strings (nunca lanza)", () => {
    expect(safeEqual("", "")).toBe(false);
    expect(safeEqual("x", "")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
    expect(safeEqual(null, "x")).toBe(false);
    expect(safeEqual("x", undefined)).toBe(false);
    expect(safeEqual(123, 123)).toBe(false);
  });
});

describe("followup isAuthorized fail-closed (Hotfix-31)", () => {
  it("sin CRON_SECRET rechaza; con secret exige match exacto", () => {
    const { isAuthorized } = followupHandler;
    const prev = process.env.CRON_SECRET;

    delete process.env.CRON_SECRET;
    expect(isAuthorized({ headers: {}, query: {} })).toBe(false);

    process.env.CRON_SECRET = "s3cr3t";
    expect(isAuthorized({ headers: {}, query: {} })).toBe(false);
    expect(isAuthorized({ headers: { authorization: "Bearer s3cr3t" }, query: {} })).toBe(true);
    expect(isAuthorized({ headers: { authorization: "Bearer wrong" }, query: {} })).toBe(false);
    expect(isAuthorized({ headers: {}, query: { secret: "s3cr3t" } })).toBe(true);
    expect(isAuthorized({ headers: { "x-vercel-cron-authorization": "s3cr3t" }, query: {} })).toBe(true);

    if (prev === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = prev;
  });
});
