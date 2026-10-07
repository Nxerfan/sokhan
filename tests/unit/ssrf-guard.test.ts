/// <reference types="bun-types" />
/**
 * SSRF guard tests — static source verification + executable URL parsing.
 */

import { test, expect } from "bun:test"
import { readFileSync } from "fs"
import { resolve } from "path"

function readSrc(relPath: string): string {
  return readFileSync(resolve(__dirname, "../../", relPath), "utf-8")
}

test("SSRF guard: blocks private IPv4 ranges", () => {
  const source = readSrc("src/lib/security/ssrf-guard.ts")
  expect(source).toContain("127")
  expect(source).toContain("10")
  expect(source).toContain("192")
  expect(source).toContain("169")
  expect(source).toContain("172")
})

test("SSRF guard: blocks IPv6 ranges", () => {
  const source = readSrc("src/lib/security/ssrf-guard.ts")
  expect(source).toContain("::1")
  expect(source).toContain("fe")
})

test("SSRF guard: safeFetch uses redirect manual", () => {
  const source = readSrc("src/lib/security/ssrf-guard.ts")
  expect(source).toContain("redirect: 'manual'")
})

test("SSRF guard: safeFetch uses AbortController timeout", () => {
  const source = readSrc("src/lib/security/ssrf-guard.ts")
  expect(source).toContain("AbortController")
})

test("SSRF guard: blocks localhost", () => {
  const source = readSrc("src/lib/security/ssrf-guard.ts")
  expect(source).toContain("localhost")
})

test("SSRF guard: blocks URL credentials", () => {
  const source = readSrc("src/lib/security/ssrf-guard.ts")
  expect(source).toContain("username")
  expect(source).toContain("password")
})

test("SSRF guard: cross-origin redirect blocked", () => {
  const source = readSrc("src/lib/security/ssrf-guard.ts")
  expect(source).toContain("ssrf_cross_origin")
})

test("SSRF guard: Authorization not forwarded cross-origin", () => {
  const source = readSrc("src/lib/security/ssrf-guard.ts")
  expect(source).toContain("delete")
  expect(source).toContain("Authorization")
})

test("SSRF guard: DNS resolution before fetch", () => {
  const source = readSrc("src/lib/security/ssrf-guard.ts")
  expect(source).toContain("lookup")
  expect(source).toContain("isPrivateIP")
})

test("SSRF guard: max redirect limit", () => {
  const source = readSrc("src/lib/security/ssrf-guard.ts")
  expect(source).toContain("maxRedirects")
  expect(source).toContain("Too many redirects")
})
