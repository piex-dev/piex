/**
 * Unit tests for aidp model list configuration.
 * Run: bun test extensions/aidp/test/models.test.ts
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MODEL_ID,
  modelDisplayName,
  parseJsonModelIds,
  parseModelIds,
} from "../src/models.ts";

describe("parseModelIds", () => {
  test("defaults to gpt-5.6-sol when env is unset or empty", () => {
    expect(parseModelIds(undefined)).toEqual([DEFAULT_MODEL_ID]);
    expect(parseModelIds("")).toEqual([DEFAULT_MODEL_ID]);
    expect(parseModelIds("  , ,  ")).toEqual([DEFAULT_MODEL_ID]);
  });

  test("splits comma-separated ids and trims whitespace", () => {
    expect(parseModelIds("gpt-5.6-sol, gpt-5.6-ultra ,foo-bar")).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-ultra",
      "foo-bar",
    ]);
  });

  test("supports switching to a single non-default model", () => {
    expect(parseModelIds("gpt-5.6-ultra")).toEqual(["gpt-5.6-ultra"]);
  });
});

describe("parseJsonModelIds", () => {
  const valid = `{
    "providers": {
      "aidp": {
        "baseUrl": "https://internal.example.com/v2/crawl",
        "api": "openai-completions",
        "models": [
          { "id": "gpt-5.6-sol", "name": "GPT-5.6 Sol" },
          { "id": "gpt-5.6-ultra" }
        ]
      }
    }
  }`;

  test("extracts model ids from providers.aidp.models", () => {
    expect(parseJsonModelIds(valid)).toEqual(["gpt-5.6-sol", "gpt-5.6-ultra"]);
  });

  test("returns undefined when aidp section is absent", () => {
    expect(parseJsonModelIds('{ "providers": { "zhipu": {} } }')).toBeUndefined();
  });

  test("returns undefined for invalid JSON", () => {
    expect(parseJsonModelIds("not json")).toBeUndefined();
  });

  test("returns undefined for empty models array", () => {
    expect(parseJsonModelIds('{ "providers": { "aidp": { "models": [] } } }')).toBeUndefined();
  });
});

describe("modelDisplayName", () => {
  test("capitalizes gpt and title-cases other segments", () => {
    expect(modelDisplayName("gpt-5.6-sol")).toBe("GPT-5.6 Sol");
    expect(modelDisplayName("gpt-5.6-ultra")).toBe("GPT-5.6 Ultra");
  });
});
