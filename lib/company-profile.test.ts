import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LOGO_MAX_BYTES,
  brandForeground,
  brandTheme,
  companyInitial,
  companyLogoPath,
  companyProfileIssue,
  logoFileIssue,
  normalizeBrandColor,
} from "./company-profile-file";

const orgId = "11111111-1111-4111-8111-111111111111";

test("companyLogoPath: stays under the company folder", () => {
  assert.equal(companyLogoPath(orgId, "image/png"), `${orgId}/logo.png`);
  assert.equal(companyLogoPath(orgId, "image/jpeg"), `${orgId}/logo.jpg`);
});

test("logoFileIssue: missing, wrong type, too large, and a valid file", () => {
  assert.equal(logoFileIssue(null), "Choose a logo to upload");
  assert.equal(logoFileIssue({ type: "image/svg+xml", size: 10 }), "Use a JPG, PNG, or WEBP image");
  assert.equal(
    logoFileIssue({ type: "image/png", size: LOGO_MAX_BYTES + 1 }),
    "Logo must be 2 MB or smaller",
  );
  assert.equal(logoFileIssue({ type: "image/webp", size: 1000 }), null);
});

test("normalizeBrandColor: accepts 3 or 6 hex digits, with or without #", () => {
  assert.equal(normalizeBrandColor("#1F3A8A"), "#1f3a8a");
  assert.equal(normalizeBrandColor("1f3a8a"), "#1f3a8a");
  assert.equal(normalizeBrandColor("#13a"), "#1133aa");
  assert.equal(normalizeBrandColor("navy"), null);
  assert.equal(normalizeBrandColor(""), null);
  assert.equal(normalizeBrandColor(null), null);
});

test("brandForeground: white on dark colours, dark on light ones", () => {
  assert.equal(brandForeground("#1f3a8a"), "#ffffff");
  assert.equal(brandForeground("#000000"), "#ffffff");
  assert.equal(brandForeground("#ffd400"), "#171717");
  assert.equal(brandForeground("#ffffff"), "#171717");
});

test("companyInitial: first letter, upper case", () => {
  assert.equal(companyInitial("demo SARL"), "D");
  assert.equal(companyInitial("  "), "R");
});

test("companyProfileIssue: name, colour and leave rate", () => {
  const valid = { name: "Demo SARL", brandColor: "#1f3a8a", monthlyLeaveDays: "1.5" };
  assert.equal(companyProfileIssue(valid), null);
  assert.equal(companyProfileIssue({ ...valid, brandColor: "" }), null);
  assert.equal(companyProfileIssue({ ...valid, name: " " }), "Company name is required");
  assert.match(companyProfileIssue({ ...valid, brandColor: "blue" }) ?? "", /hex code/);
  assert.match(companyProfileIssue({ ...valid, monthlyLeaveDays: "0" }) ?? "", /monthly leave rate/);
  assert.match(companyProfileIssue({ ...valid, monthlyLeaveDays: 6 }) ?? "", /monthly leave rate/);
});

test("brandTheme: accents follow the brand only when readable on white", () => {
  const dark = brandTheme("#1f3a8a");
  assert.equal(dark["--brand"], "#1f3a8a");
  assert.equal(dark["--brand-foreground"], "#ffffff");
  assert.equal(dark["--ds-primary"], "#1f3a8a");
  const light = brandTheme("#ffd400");
  assert.equal(light["--brand-foreground"], "#171717");
  assert.equal(light["--ds-primary"], undefined);
});
