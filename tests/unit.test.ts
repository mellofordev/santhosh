import { describe, expect, test } from "bun:test";
import {
  generateIdentity,
  parse,
  serialize,
  signUnit,
  verifyUnit,
} from "../packages/protocol/src/index.ts";

describe("unit", () => {
  test("sign / serialize / parse / verify roundtrip", async () => {
    const id = await generateIdentity();
    const unit = await signUnit(
      {
        topic: "santhosh/v1/general",
        parents: [],
        tags: ["test"],
        summary: "first",
        body: "# Hello\n\nworld",
      },
      id,
    );
    const md = serialize(unit);
    const parsed = parse(md);
    expect(parsed.frontmatter.id).toBe(unit.frontmatter.id);
    expect(parsed.body.trim()).toBe(unit.body.trim());
    expect(await verifyUnit(parsed)).toBe(true);
  });

  test("tampered body fails verification", async () => {
    const id = await generateIdentity();
    const unit = await signUnit(
      {
        topic: "santhosh/v1/general",
        parents: [],
        tags: [],
        summary: "x",
        body: "original",
      },
      id,
    );
    unit.body = "tampered";
    expect(await verifyUnit(unit)).toBe(false);
  });
});
