import { describe, expect, test } from "bun:test";
import { TeaSDK } from "@dp/tea-sdk-node";
import { reportUser } from "../src/ai-code-report.ts";

function captureUserIds(sdk: TeaSDK, plugIn: () => void): string[] {
  const ids: string[] = [];
  sdk.use({
    name: "capture",
    onSendEvent: (event) => {
      ids.push(
        String(
          (event as never as { event: { user: { user_unique_id: string } } })
            .event.user.user_unique_id,
        ),
      );
    },
  });
  plugIn();
  return ids;
}

describe("ai-code-report user identity", () => {
  test("anonymous reports clear a previously configured identity", () => {
    const sdk = new TeaSDK({ app_id: 1 });
    const ids = captureUserIds(sdk, () => {
      sdk.config({ user: reportUser("alice") });
      sdk.collect("first", {}, { user: reportUser("alice") });
      sdk.config({ user: reportUser(undefined) });
      sdk.collect("second", {}, { user: reportUser(undefined) });
    });

    expect(ids).toEqual(["alice", "anonymous"]);
  });

  test("reportUser keeps a real id and clears an absent one", () => {
    expect(reportUser("alice")).toEqual({ user_unique_id: "alice" });
    expect(reportUser(undefined)).toEqual({ user_unique_id: "" });
  });
});
