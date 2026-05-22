/**
 * lookup_breed_test.ts
 *
 * Demonstrates how to test a tool handler in isolation using Deno.test.
 * Run with: deno test --allow-env lookup_breed_test.ts
 *
 * These tests exercise the handler directly — no HTTP server needed.
 * They validate:
 *   1. Happy path for each of the four mock breeds
 *   2. Alias resolution (GSD → German Shepherd, etc.)
 *   3. Not-found response structure
 *   4. that the cta field is always present
 *   5. that coaching_note is always present and non-empty
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { lookupBreed } from "./tools/lookup_breed.ts";
import type { AuthContext } from "./auth.ts";

// A minimal demo context — lookup_breed doesn't use auth, but the signature requires it
const demoCtx: AuthContext = { kind: "demo" };

// --- Happy path tests ---

Deno.test("lookup_breed: Border Collie by full name", async () => {
  const result = await lookupBreed({ breed: "Border Collie" }, demoCtx);
  assertEquals(result.isError, false);
  const profile = JSON.parse(result.content[0].text);
  assertEquals(profile.breed, "Border Collie");
  assertEquals(profile.group, "Herding");
  assertEquals(profile.reactivity_type, "excitement-based");
  assertStringIncludes(profile.cta, "calming-paws.com");
  assertEquals(typeof profile.coaching_note, "string");
  assertEquals(profile.coaching_note.length > 0, true);
  assertEquals(Array.isArray(profile.common_triggers), true);
  assertEquals(Array.isArray(profile.recommended_protocols), true);
});

Deno.test("lookup_breed: Chihuahua — fear-based type", async () => {
  const result = await lookupBreed({ breed: "Chihuahua" }, demoCtx);
  assertEquals(result.isError, false);
  const profile = JSON.parse(result.content[0].text);
  assertEquals(profile.reactivity_type, "fear-based");
  // Critical guardrail note should mention not forcing greetings
  assertStringIncludes(profile.coaching_note.toLowerCase(), "fear");
});

Deno.test("lookup_breed: German Shepherd — mixed type", async () => {
  const result = await lookupBreed({ breed: "German Shepherd" }, demoCtx);
  assertEquals(result.isError, false);
  const profile = JSON.parse(result.content[0].text);
  assertEquals(profile.breed, "German Shepherd Dog");
  assertEquals(profile.reactivity_type, "mixed");
  // Should mention pain/hip dysplasia
  assertStringIncludes(profile.coaching_note.toLowerCase(), "pain");
});

Deno.test("lookup_breed: Labrador Retriever — frustration-based type", async () => {
  const result = await lookupBreed({ breed: "Labrador Retriever" }, demoCtx);
  assertEquals(result.isError, false);
  const profile = JSON.parse(result.content[0].text);
  assertEquals(profile.reactivity_type, "frustration-based");
  assertStringIncludes(profile.coaching_note.toLowerCase(), "frustrat");
});

// --- Alias tests ---

Deno.test("lookup_breed: 'GSD' alias resolves to German Shepherd", async () => {
  const result = await lookupBreed({ breed: "GSD" }, demoCtx);
  assertEquals(result.isError, false);
  const profile = JSON.parse(result.content[0].text);
  assertEquals(profile.breed, "German Shepherd Dog");
});

Deno.test("lookup_breed: 'Lab' alias resolves to Labrador Retriever", async () => {
  const result = await lookupBreed({ breed: "Lab" }, demoCtx);
  assertEquals(result.isError, false);
  const profile = JSON.parse(result.content[0].text);
  assertEquals(profile.breed, "Labrador Retriever");
});

Deno.test("lookup_breed: 'BC' alias resolves to Border Collie", async () => {
  const result = await lookupBreed({ breed: "BC" }, demoCtx);
  assertEquals(result.isError, false);
  const profile = JSON.parse(result.content[0].text);
  assertEquals(profile.breed, "Border Collie");
});

Deno.test("lookup_breed: case-insensitive lookup", async () => {
  const result = await lookupBreed({ breed: "LABRADOR RETRIEVER" }, demoCtx);
  assertEquals(result.isError, false);
  const profile = JSON.parse(result.content[0].text);
  assertEquals(profile.breed, "Labrador Retriever");
});

// --- Not found ---

Deno.test("lookup_breed: unknown breed returns structured error", async () => {
  const result = await lookupBreed({ breed: "Foobarshire Spaniel" }, demoCtx);
  assertEquals(result.isError, true);
  const err = JSON.parse(result.content[0].text);
  assertEquals(err.code, "not_found");
  assertEquals(typeof err.message, "string");
  assertEquals(Array.isArray(err.available_breeds), true);
  // The available_breeds list should include our four mock breeds
  assertEquals(err.available_breeds.includes("Border Collie"), true);
  assertEquals(err.available_breeds.includes("Labrador Retriever"), true);
});

// --- CTA field ---

Deno.test("lookup_breed: cta always points to calming-paws.com", async () => {
  const breeds = ["Border Collie", "Chihuahua", "German Shepherd", "Labrador Retriever"];
  for (const breed of breeds) {
    const result = await lookupBreed({ breed }, demoCtx);
    assertEquals(result.isError, false);
    const profile = JSON.parse(result.content[0].text);
    assertStringIncludes(profile.cta, "calming-paws.com");
  }
});

// --- coaching_note voice check ---

Deno.test("lookup_breed: coaching_note contains Shadow's voice markers", async () => {
  // Shadow uses 🐾 in coaching notes per SKILL.md persona
  const result = await lookupBreed({ breed: "Border Collie" }, demoCtx);
  const profile = JSON.parse(result.content[0].text);
  assertStringIncludes(profile.coaching_note, "🐾");
});
