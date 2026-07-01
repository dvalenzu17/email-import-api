import { describe, it, expect } from "vitest";
import { parsePushEnvelope, verifyPushToken, buildWatchRequest } from "../src/services/gmailPushUtil.js";

function envelope(obj) {
  return { message: { data: Buffer.from(JSON.stringify(obj)).toString("base64"), messageId: "1" } };
}

describe("parsePushEnvelope", () => {
  it("decodes a valid Gmail push envelope", () => {
    const out = parsePushEnvelope(envelope({ emailAddress: "Me@Gmail.com", historyId: 98765 }));
    expect(out).toEqual({ emailAddress: "me@gmail.com", historyId: "98765" });
  });

  it("coerces a string historyId", () => {
    const out = parsePushEnvelope(envelope({ emailAddress: "a@b.com", historyId: "42" }));
    expect(out).toEqual({ emailAddress: "a@b.com", historyId: "42" });
  });

  it("returns null when data is missing", () => {
    expect(parsePushEnvelope({ message: {} })).toBeNull();
    expect(parsePushEnvelope({})).toBeNull();
    expect(parsePushEnvelope(null)).toBeNull();
  });

  it("returns null on non-base64 / non-JSON data", () => {
    expect(parsePushEnvelope({ message: { data: "%%%not-base64%%%" } })).toBeNull();
  });

  it("returns null when required fields are absent", () => {
    expect(parsePushEnvelope(envelope({ emailAddress: "a@b.com" }))).toBeNull();
    expect(parsePushEnvelope(envelope({ historyId: 5 }))).toBeNull();
  });
});

describe("verifyPushToken", () => {
  it("accepts a matching token", () => {
    expect(verifyPushToken("s3cret", "s3cret")).toBe(true);
  });

  it("rejects a mismatch or wrong length", () => {
    expect(verifyPushToken("s3cret", "nope")).toBe(false);
    expect(verifyPushToken("s3cret", "s3creT")).toBe(false);
  });

  it("fails closed when not configured or not provided", () => {
    expect(verifyPushToken("", "anything")).toBe(false);
    expect(verifyPushToken(undefined, "anything")).toBe(false);
    expect(verifyPushToken("s3cret", undefined)).toBe(false);
  });
});

describe("buildWatchRequest", () => {
  it("watches only INBOX for the given topic", () => {
    expect(buildWatchRequest("projects/p/topics/t")).toEqual({
      topicName: "projects/p/topics/t",
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
    });
  });
});
