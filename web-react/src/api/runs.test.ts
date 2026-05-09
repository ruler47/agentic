import { describe, expect, it } from "vitest";

import { fileToRunAttachment, filesToRunAttachments } from "@/api/runs";

describe("run attachments", () => {
  it("encodes browser files as run attachment payloads", async () => {
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });

    await expect(fileToRunAttachment(file)).resolves.toEqual({
      filename: "hello.txt",
      mimeType: "text/plain",
      contentBase64: "aGVsbG8=",
    });
  });

  it("encodes multiple files in order", async () => {
    const attachments = await filesToRunAttachments([
      new File(["one"], "one.txt", { type: "text/plain" }),
      new File(["two"], "two.bin"),
    ]);

    expect(attachments.map((attachment) => attachment.filename)).toEqual(["one.txt", "two.bin"]);
    expect(attachments.map((attachment) => attachment.contentBase64)).toEqual(["b25l", "dHdv"]);
    expect(attachments[1].mimeType).toBeUndefined();
  });
});
