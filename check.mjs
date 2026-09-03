#!/usr/bin/env node
// wedjat-check: ask the HORIZON SHIELD verification gate to measure an MCP endpoint,
// recompute the verdict hash locally, and fail the job by the policy you chose.
//
// Read-only by default. The gate calls no tool on your server unless you set
// allow_tool_call=true, which you should only do for a server you own.
//
// Everything here is also reachable with one curl:
//   curl -s -X POST https://gate.horizonshield.dev/check \
//     -H 'content-type: application/json' -d '{"endpoint":"https://your-server/mcp"}'
//
// Inputs come from the environment (set by action.yml) so the same file runs anywhere:
//   WEDJAT_ENDPOINT        https URL of the MCP endpoint to measure (required)
//   WEDJAT_GATE            gate origin, default https://gate.horizonshield.dev
//   WEDJAT_REQUIRE         verified | measured-pass | none   (default measured-pass)
//   WEDJAT_ALLOW_TOOL_CALL true | false                      (default false)
//   WEDJAT_MUST_PASS       comma list of condition keys that must be measured AND pass
//   WEDJAT_TIMEOUT_MS      default 60000
//   GITHUB_OUTPUT / GITHUB_STEP_SUMMARY are honoured when present.

import fs from "node:fs";
import { createHash } from "node:crypto";

const env = process.env;
const endpoint = (env.WEDJAT_ENDPOINT || "").trim();
const gate = (env.WEDJAT_GATE || "https://gate.horizonshield.dev").replace(/\/+$/, "");
const require_ = (env.WEDJAT_REQUIRE || "measured-pass").trim();
const allowToolCall = /^true$/i.test(env.WEDJAT_ALLOW_TOOL_CALL || "false");
const mustPass = (env.WEDJAT_MUST_PASS || "").split(",").map((s) => s.trim()).filter(Boolean);
const timeoutMs = Number(env.WEDJAT_TIMEOUT_MS || 60000);

const LABELS = {
  mcp_endpoint: "MCP endpoint",
  agent_card: "Agent card",
  compensation_disclosure: "Compensation disclosure",
  determinism: "Determinism",
  self_verification: "Self verification",
};

function die(msg, code = 2) {
  console.error("wedjat-check: " + msg);
  process.exit(code);
}
function setOutput(k, v) {
  if (!env.GITHUB_OUTPUT) return;
  const s = String(v);
  if (s.includes("\n")) fs.appendFileSync(env.GITHUB_OUTPUT, `${k}<<__WEDJAT__\n${s}\n__WEDJAT__\n`);
  else fs.appendFileSync(env.GITHUB_OUTPUT, `${k}=${s}\n`);
}
function summary(md) {
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, md + "\n");
}
function condWord(c) {
  if (c && c.detail && c.detail.applicable === false) return "n/a";
  if (c && (c.measured === false || (c.detail && c.detail.self_measured === false))) return "not measured";
  if (c && c.pass === true) return "pass";
  return "fail";
}
// Same arithmetic as the directory page and the gate's verify_verdict tool:
// drop record_sha256 and recompute_note, JSON.stringify the rest in the order received, SHA-256.
function recompute(record) {
  const r = JSON.parse(JSON.stringify(record));
  const expected = r.record_sha256;
  delete r.record_sha256;
  delete r.recompute_note;
  const got = createHash("sha256").update(JSON.stringify(r)).digest("hex");
  return { expected, got, match: expected === got };
}

if (!endpoint) die("WEDJAT_ENDPOINT is required");
let u;
try { u = new URL(endpoint); } catch { die("endpoint is not a URL: " + endpoint); }
if (u.protocol !== "https:") die("endpoint must be https");
if (!["verified", "measured-pass", "none"].includes(require_)) die("require must be verified, measured-pass or none");

const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), timeoutMs);
let record;
try {
  const res = await fetch(gate + "/check", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "wedjat-check-action" },
    body: JSON.stringify(allowToolCall ? { endpoint, allow_tool_call: true } : { endpoint }),
    signal: ctrl.signal,
  });
  const text = await res.text();
  try { record = JSON.parse(text); } catch { die(`gate answered ${res.status} with non-JSON: ${text.slice(0, 200)}`); }
  if (!res.ok && !record.status) die(`gate answered ${res.status}: ${text.slice(0, 200)}`);
} catch (e) {
  if (e && e.name === "AbortError") die("gate did not answer within " + timeoutMs + " ms. That is a fact about the network, not a verdict.", 3);
  die("could not reach the gate: " + (e && e.message ? e.message : String(e)), 3);
} finally {
  clearTimeout(timer);
}

if (record.error) die("gate returned an error: " + String(record.error), 3);

const status = String(record.status || "unknown");
const checks = record.checks || {};
const keys = Object.keys(checks);
const words = Object.fromEntries(keys.map((k) => [k, condWord(checks[k])]));
const failed = keys.filter((k) => words[k] === "fail");
const unmeasured = keys.filter((k) => words[k] === "not measured");
const rc = record.record_sha256 ? recompute(record) : null;

// Print the verdict the way the page shows it, one condition per line, no colour tricks.
console.log(`${status.toUpperCase()} · ${endpoint}`);
for (const k of keys) {
  const c = checks[k] || {};
  console.log(`  ${(LABELS[k] || k).padEnd(24)} ${words[k].padEnd(13)} ${c.reason ? String(c.reason) : ""}`.trimEnd());
}
if (rc) console.log(`record_sha256 ${rc.expected}  recomputed locally: ${rc.match ? "match" : "MISMATCH, got " + rc.got}`);
else console.log("record carries no record_sha256, nothing to recompute");

setOutput("status", status);
setOutput("record_sha256", rc ? rc.expected : "");
setOutput("recompute_match", rc ? String(rc.match) : "");
setOutput("failed_conditions", failed.join(","));
setOutput("unmeasured_conditions", unmeasured.join(","));
setOutput("record", JSON.stringify(record));

summary(`### wedjat-check · ${status.toUpperCase()}\n\n\`${endpoint}\`\n\n| condition | result | reason |\n|---|---|---|\n` +
  keys.map((k) => `| ${LABELS[k] || k} | ${words[k]} | ${(checks[k] && checks[k].reason) ? String(checks[k].reason).replace(/\|/g, "\\|") : ""} |`).join("\n") +
  (rc ? `\n\n\`record_sha256\` ${rc.expected}, recomputed in this job: **${rc.match ? "match" : "mismatch"}**` : "") +
  `\n\nRedo it yourself: https://shield.the-horizons-innovation.com/verify-directory/?endpoint=${encodeURIComponent(endpoint)}`);

// Policy. The gate never decides whether your build ships; this file does, by the rule you picked.
const problems = [];
if (rc && !rc.match) problems.push("record_sha256 did not recompute: the verdict bytes were altered in transit or the gate changed its arithmetic. Do not trust this run either way.");
if (require_ === "verified" && status !== "verified") problems.push(`status is ${status}, required verified`);
if (require_ === "measured-pass" && failed.length) problems.push("measured conditions failing: " + failed.join(", "));
for (const k of mustPass) {
  if (!(k in words)) problems.push(`must_pass names an unknown condition: ${k} (known: ${keys.join(", ")})`);
  else if (words[k] !== "pass") problems.push(`${k} is ${words[k]}, must be a measured pass`);
}
if (problems.length) {
  console.error("\nwedjat-check failed:");
  for (const p of problems) console.error("  " + p);
  process.exit(1);
}
console.log("\nwedjat-check passed under policy " + require_ + (mustPass.length ? " with must_pass " + mustPass.join(",") : "") + ".");
