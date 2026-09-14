import { expect, it } from "vitest";
import {
  cloneImageAlphaPolicy,
  parseSrgbHex,
  srgbHex,
  validateImageAlphaPolicy,
} from "../imageAlphaPolicy";

it("deep-clones the nested background for preset, batch and async boundaries", () => {
  const source = {kind:"flatten" as const,background:{red:17,green:34,blue:51}};
  const clone = cloneImageAlphaPolicy(source);
  expect(clone).toEqual(source);
  expect(clone).not.toBe(source);
  expect(clone?.background).not.toBe(source.background);
  source.background.red = 200;
  expect(clone?.background.red).toBe(17);
});

it("does not turn absent policy into the suggested White background", () => {
  expect(cloneImageAlphaPolicy(null)).toBeNull();
  expect(cloneImageAlphaPolicy(undefined)).toBeNull();
  expect(validateImageAlphaPolicy(undefined)).toBeNull();
});

it("parses and formats exact custom sRGB bytes", () => {
  expect(parseSrgbHex("#112233")).toEqual({red:17,green:34,blue:51});
  expect(srgbHex({red:17,green:34,blue:51})).toBe("#112233");
  expect(parseSrgbHex("112233")).toBeNull();
});
