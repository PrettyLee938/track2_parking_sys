/**
 * What a level's webhooks look like: event classes and fields, signature check results
 * (and, if they fail, which variant of the algorithm would match), car types and routing,
 * CO readings, component failures, penalties, and what the time fields measure.
 * Run it after letting a new level play for a few minutes (GPA_SIGNATURE_MODE=monitor).
 *   npm run report:level -w server -- [HH:MM] [HH:MM] [YYYY-MM-DD]     (default: last hour)
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { computeSignature } from "../src/webhook";
import { cfg } from "./site";

type Ev = Record<string, string> & { _t: number; _sig: string; _accepted: number };

const [fromArg, toArg, dayArg] = process.argv.slice(2);
const day = dayArg ?? new Date().toLocaleDateString("sv");
const from = fromArg ? new Date(`${day}T${fromArg}`).getTime() : Date.now() - 3600_000;
const to = toArg ? new Date(`${day}T${toArg}`).getTime() : Date.now();

const db = new Database(path.join(cfg.dataDir, "gpa.db"), { readonly: true });
const events: Ev[] = (db.prepare("SELECT received_ms, sig, accepted, payload FROM events WHERE received_ms BETWEEN ? AND ? ORDER BY id")
  .all(from, to) as { received_ms: number; sig: string; accepted: number; payload: string }[])
  .map((r) => ({ ...JSON.parse(r.payload), _t: r.received_ms, _sig: r.sig, _accepted: r.accepted }));
const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });
const section = (t: string) => console.log(`\n=== ${t} ${"=".repeat(Math.max(0, 70 - t.length))}`);
const tally = (xs: string[]) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const print = (rows: [string, number][], indent = "  ") => { for (const [k, n] of rows) console.log(`${indent}${String(n).padStart(6)}  ${k}`); };
const payload = (e: Ev) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith("_")));

if (!events.length) { console.log(`no events between ${clock(from)} and ${clock(to)}`); process.exit(0); }
console.log(`${events.length} events, ${clock(events[0]._t)} - ${clock(events.at(-1)!._t)}`);

// ---------------------------------------------------------------------------
section("event classes (signature status, acted on)");
print(tally(events.map((e) => `${e.EventClass.padEnd(24)} sig=${e._sig.padEnd(8)} ${e._accepted ? "accepted" : "DROPPED"}`)));

// ---------------------------------------------------------------------------
section("signatures");
const signed = events.filter((e) => e.Signature);
const valid = signed.filter((e) => computeSignature(payload(e)) === e.Signature.toLowerCase());
console.log(`  ${signed.length} signed, ${valid.length} match our algorithm (md5 of values sorted by key, joined by "|")`);
if (signed.length > valid.length) {
  // Try plausible variations, and a shared secret from the simulator's settings.json.
  const settings = cfg.simSettingsFile && existsSync(cfg.simSettingsFile)
    ? JSON.parse(readFileSync(cfg.simSettingsFile, "utf8").replace(/^﻿/, "")) as Record<string, unknown> : {};
  const secrets = Object.entries(settings).filter(([, v]) => typeof v === "string" && v).map(([k, v]) => [k, String(v)] as const);
  const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
  const values = (p: Record<string, unknown>, keys: string[]) => keys.map((k) => String(p[k]));
  const keysOf = (p: Record<string, unknown>) => Object.keys(p).filter((k) => k !== "Signature");
  const variants: [string, (p: Record<string, unknown>) => string][] = [
    ["case-insensitive key order", (p) => md5(values(p, keysOf(p).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))).join("|"))],
    ["payload key order (unsorted)", (p) => md5(values(p, keysOf(p)).join("|"))],
    ["skip null/empty values", (p) => md5(values(p, keysOf(p).filter((k) => p[k] !== null && p[k] !== "").sort()).join("|"))],
    ["key=value pairs", (p) => md5(keysOf(p).sort().map((k) => `${k}=${p[k]}`).join("|"))],
    ["no separator", (p) => md5(values(p, keysOf(p).sort()).join(""))],
    ...secrets.flatMap(([name, s]): [string, (p: Record<string, unknown>) => string][] => [
      [`secret ${name} appended`, (p) => md5([...values(p, keysOf(p).sort()), s].join("|"))],
      [`secret ${name} prepended`, (p) => md5([s, ...values(p, keysOf(p).sort())].join("|"))],
      [`secret ${name} concatenated`, (p) => md5(values(p, keysOf(p).sort()).join("|") + s)],
    ]),
  ];
  const bad = signed.filter((e) => !valid.includes(e));
  for (const [name, fn] of variants) {
    const n = bad.filter((e) => fn(payload(e)) === e.Signature.toLowerCase()).length;
    if (n) console.log(`  ${n}/${bad.length} failing ones match variant: ${name}`);
  }
  console.log("  failing examples:");
  for (const e of bad.slice(0, 3)) console.log(`    ${JSON.stringify(payload(e))}  ours=${computeSignature(payload(e))}`);
}

// ---------------------------------------------------------------------------
section("fields per event class (one example each)");
const byClass = new Map<string, Ev[]>();
for (const e of events) byClass.set(e.EventClass, [...(byClass.get(e.EventClass) ?? []), e]);
for (const [cls, es] of byClass) {
  const keys = new Set(es.flatMap((e) => Object.keys(payload(e))));
  console.log(`  ${cls} (${es.length}): ${[...keys].join(", ")}`);
  console.log(`    e.g. ${JSON.stringify(payload(es.at(-1)!))}`);
}

// ---------------------------------------------------------------------------
section("cars");
const cars = events.filter((e) => e.EventClass === "car_spot_action");
print(tally(cars.filter((e) => e.SpotType === "EntrySpot" && e.Direction === "CarIn").map((e) => `arrived at ${e.SpotName} - ${e.CarType}`)));
// Zone of each parking spot, from the latest discovery snapshot (npm run discover).
const discoveryDir = path.join(cfg.dataDir, "discovery");
const latest = existsSync(discoveryDir) ? readdirSync(discoveryDir).filter((f) => f.endsWith(".json")).sort().at(-1) : undefined;
const spotInfo = new Map<string, { zone: string; type: string }>();
if (latest) {
  for (const s of JSON.parse(readFileSync(path.join(discoveryDir, latest), "utf8")).spots as { name: string; zoneParent: string; parkingForCarType: string }[]) {
    spotInfo.set(s.name, { zone: s.zoneParent, type: s.parkingForCarType });
  }
}
const entryOf = new Map<string, string>();
const routes: string[] = [];
for (const e of cars) {
  if (e.SpotType === "EntrySpot" && e.Direction === "CarIn") entryOf.set(e.CarPlateNumber, e.SpotName);
  if (e.SpotType === "Park" && e.Direction === "CarIn") {
    const info = spotInfo.get(e.SpotName);
    routes.push(`${entryOf.get(e.CarPlateNumber) ?? "?"} -> ${info?.zone ?? "?"} | ${e.CarType} car in ${info?.type ?? "?"} spot`);
  }
  if (e.SpotType === "ExitSpot" && e.Direction === "CarIn") routes.push(`${entryOf.get(e.CarPlateNumber) ?? "?"} -> exit ${e.SpotName}`);
}
console.log(`  routes${latest ? "" : " (run `npm run discover -w server` for spot zones/types)"}:`);
print(tally(routes), "    ");

// ---------------------------------------------------------------------------
section("carbon monoxide");
const co = events.filter((e) => e.EventClass === "carbon_monoxide_event");
if (!co.length) console.log("  none (only sent at Mid level and above)");
for (const [zone] of tally(co.map((e) => e.ZoneName))) {
  const zs = co.filter((e) => e.ZoneName === zone), levels = zs.map((e) => Number(e.CarbonMonoxideLevel));
  const gaps = zs.slice(1).map((e, i) => (e._t - zs[i]._t) / 1000);
  console.log(`  ${zone}: ${zs.length} readings, CO ${Math.min(...levels).toFixed(1)}-${Math.max(...levels).toFixed(1)}, ` +
    `levels ${tally(zs.map((e) => e.DangerLevel)).map(([k, n]) => `${k} ${n}`).join(", ")}, ` +
    `every ~${gaps.length ? (gaps.reduce((a, b) => a + b, 0) / gaps.length).toFixed(1) : "?"} s, ${clock(zs[0]._t)} - ${clock(zs.at(-1)!._t)}`);
}

// ---------------------------------------------------------------------------
section("components broken / fixed");
const comp = events.filter((e) => e.EventClass === "component_broken" || e.EventClass === "component_fixed");
if (!comp.length) console.log("  none");
for (const e of comp) {
  console.log(`  ${clock(e._t)} ${e.EventClass === "component_broken" ? "BROKEN" : "fixed "} ${e.Type} ${e.Name}` +
    `${e.FineAmount ? ` fine ${e.FineAmount}` : ""}${e.RepairCost ? ` repair cost ${e.RepairCost}` : ""}`);
}

// ---------------------------------------------------------------------------
section("penalties");
const pen = events.filter((e) => e.EventClass === "penalty");
if (!pen.length) console.log("  none");
print(tally(pen.map((e) => `${e.Type ?? "?"}: ${String(e.Reason).replace(/\([^)]*\)/g, "(...)")}`)));

// ---------------------------------------------------------------------------
section("time fields (is anything on game time? day/night?)");
const stamped = events.filter((e) => e.ServerDateTime);
if (stamped.length > 1) {
  const first = stamped[0], last = stamped.at(-1)!;
  const realS = (last._t - first._t) / 1000;
  for (const field of ["ServerDateTime", "RealDateTime"]) {
    if (!first[field] || !last[field]) { console.log(`  ${field}: not present`); continue; }
    const t = (e: Ev) => Date.parse(e[field].replace(" ", "T"));
    const ratio = (t(last) - t(first)) / 1000 / realS;
    console.log(`  ${field}: ${first[field]} -> ${last[field]}, advances x${ratio.toFixed(2)} vs our clock ` +
      `(x1 = wall clock, ~game speed = game time); offset from receipt ${((t(last) - last._t) / 1000).toFixed(0)} s`);
  }
  const hours = tally(stamped.map((e) => e.ServerDateTime.slice(11, 13)));
  console.log(`  ServerDateTime hours seen: ${hours.map(([h, n]) => `${h}h:${n}`).sort().join(" ")}`);
}

// ---------------------------------------------------------------------------
section("delivery");
const seqs = events.map((e) => Number(e.SequenceId)).filter(Number.isFinite);
let gaps = 0, back = 0;
for (let i = 1; i < seqs.length; i++) { if (seqs[i] > seqs[i - 1] + 1) gaps += seqs[i] - seqs[i - 1] - 1; if (seqs[i] <= seqs[i - 1]) back++; }
console.log(`  sequence ${seqs[0]}..${seqs.at(-1)}: ${gaps} missing, ${back} out of order / repeated`);
