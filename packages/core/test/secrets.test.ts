import { describe, expect, it } from "vitest";
import { isSecretPath } from "@tinystrap/core";

describe("secret paths", () => {
  it("flags credential paths", () => {
    for (const p of [".env", "config/.env.prod", "certs/server.pem",
      ".ssh/id_ed25519", ".aws/credentials", "app/.git-credentials",
      "deploy/secrets/prod.txt"]) {
      expect(isSecretPath(p), p).toBe(true);
    }
  });
  it("allows normal and example paths", () => {
    for (const p of ["src/main.ts", ".env.example", "docs/keys.md"]) {
      expect(isSecretPath(p), p).toBe(false);
    }
  });
});
