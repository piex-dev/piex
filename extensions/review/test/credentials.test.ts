import { describe, expect, test } from "bun:test";
import { credentialFileReason } from "../src/credentials.ts";

describe("credentialFileReason", () => {
  test("matches dotfiles case-insensitively", () => {
    for (const file of [
      ".env",
      ".ENV",
      ".Env.local",
      ".npmrc",
      ".NPMRC",
      ".docker/config.json",
      ".DOCKER/CONFIG.JSON",
      ".token",
      ".SECRET",
      ".password",
    ]) {
      expect(credentialFileReason(file)).toBe("credentials");
    }
  });

  test("matches extensionless credential stores", () => {
    for (const file of [
      ".aws/credentials",
      ".AWS/credentials",
      "deploy/.git-credentials",
      ".pgpass",
      ".htpasswd",
      ".dockercfg",
      ".kube/config",
    ]) {
      expect(credentialFileReason(file)).toBe("credentials");
    }
  });

  test("keeps env templates reviewable", () => {
    for (const file of [
      ".env.example",
      ".ENV.EXAMPLE",
      "config/.env.sample",
      ".env.template",
      ".env.dist",
    ]) {
      expect(credentialFileReason(file)).toBeUndefined();
    }
    expect(credentialFileReason(".env.local")).toBe("credentials");
    expect(credentialFileReason(".env.example.local")).toBe("credentials");
  });

  test("matches private key names", () => {
    expect(credentialFileReason("deploy/server.pem")).toBe("private key");
    expect(credentialFileReason("remote-key")).toBeUndefined();
    expect(credentialFileReason("id_ed25519")).toBe("private key");
  });
});
