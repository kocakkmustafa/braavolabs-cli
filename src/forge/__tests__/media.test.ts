import { describe, it, expect } from "vitest";
import {
  parseSize,
  estimateUsd,
  renderMediaPreview,
  renderImageResult,
  decodeAudio,
} from "../media";

// Identity ui — render helpers just format strings; assert on content.
const ui = {
  primary: (s: string) => s,
  steel: (s: string) => s,
  ember: (s: string) => s,
  dim: (s: string) => s,
  fail: (s: string) => `FAIL:${s}`,
};

describe("parseSize", () => {
  it("parses WxH", () => expect(parseSize("1024x768")).toEqual({ width: 1024, height: 768 }));
  it("treats a bare number as square", () => expect(parseSize("512")).toEqual({ width: 512, height: 512 }));
  it("defaults to 1024x1024", () => expect(parseSize(undefined)).toEqual({ width: 1024, height: 1024 }));
  it("rejects malformed input", () => expect(() => parseSize("big")).toThrow(/bad --size/));
  it("rejects out-of-range (server bounds 256..1536)", () => {
    expect(() => parseSize("2000x2000")).toThrow(/out of range/);
    expect(() => parseSize("100x100")).toThrow(/out of range/);
  });
});

describe("estimateUsd", () => {
  it("reads .usd", () => expect(estimateUsd({ usd: 0.52 })).toBe(0.52));
  it("is 0 for null / non-numeric (never NaN sent as ack)", () => {
    expect(estimateUsd(null)).toBe(0);
    expect(estimateUsd({ usd: "x" })).toBe(0);
    expect(estimateUsd(undefined)).toBe(0);
  });
});

describe("renderMediaPreview", () => {
  it("shows the estimated cost (honesty surface)", () => {
    const lines = renderMediaPreview(ui, { usd: 0.025, note: "flux/dev" }, true, false);
    expect(lines.join("\n")).toContain("$0.0250");
    expect(lines.join("\n")).toContain("flux/dev");
  });
  it("warns + hints the media-key command when no key is configured", () => {
    const lines = renderMediaPreview(ui, { usd: 0.5 }, false, false).join("\n");
    expect(lines).toContain("no provider key");
    expect(lines).toContain("forge keys add");
  });
  it("prompts for --yes only when a key exists and the user has not opted in", () => {
    expect(renderMediaPreview(ui, { usd: 0.5 }, true, false).join("\n")).toContain("add --yes to generate");
    expect(renderMediaPreview(ui, { usd: 0.5 }, true, true).join("\n")).not.toContain("add --yes");
  });
});

describe("renderImageResult", () => {
  it("lists the provider-CDN URLs", () => {
    const lines = renderImageResult(ui, { images: [{ url: "https://cdn/a.png" }, { url: "https://cdn/b.png" }], urlNote: "expires" }).join("\n");
    expect(lines).toContain("2 images");
    expect(lines).toContain("https://cdn/a.png");
    expect(lines).toContain("expires");
  });
  it("fails cleanly when the response carries no URL", () => {
    expect(renderImageResult(ui, { images: [] }).join("\n")).toContain("FAIL:");
  });
});

describe("decodeAudio", () => {
  it("round-trips base64 to the original bytes", () => {
    const original = Buffer.from("fake-mp3-bytes");
    const b64 = original.toString("base64");
    expect(decodeAudio(b64).equals(original)).toBe(true);
  });
});
