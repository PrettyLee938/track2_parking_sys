import {
  EventClass,
  type NormalizedCarbonMonoxideEvent,
  type NormalizedCollection,
  type NormalizedExhaustFan,
  type NormalizedLight,
  type NormalizedZone,
  type Observed,
  type UnavailableReason,
} from "@gpa/shared";

type JsonObject = Record<string, unknown>;
type ValueKind = "string" | "number" | "boolean";
type Extraction = { rows: unknown[]; shape: "array" | "wrapped-array" | "single-row" | "unknown"; issue?: string };

const normalizeKey = (key: string) => key.replace(/[^a-z\d]/gi, "").toLowerCase();

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable<T>(reason: UnavailableReason = "missing", sourceKeys: string[] = []): Observed<T> {
  return { available: false, value: null, sourceKeys, reason };
}

function parseValue(value: unknown, kind: ValueKind): string | number | boolean | null {
  if (kind === "string") return typeof value === "string" && value.trim() ? value : null;
  if (kind === "number") {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
    return null;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.trim().toLowerCase() === "true") return true;
    if (value.trim().toLowerCase() === "false") return false;
  }
  return null;
}

function observe<T>(row: JsonObject, fieldName: string, kind: ValueKind, aliases: string[] = [fieldName]): Observed<T> {
  const wanted = new Set(aliases.map(normalizeKey));
  const keys = Object.keys(row).filter((key) => wanted.has(normalizeKey(key)));
  if (!keys.length) return unavailable<T>();
  if (keys.length > 1) return unavailable<T>("ambiguous", keys);
  const key = keys[0];
  const value = parseValue(row[key], kind);
  if (value === null) return unavailable<T>("invalid", [key]);
  return { available: true, value: value as T, sourceKeys: [key] };
}

function extractRows(input: unknown, rowNameAliases: string[], wrapperAliases: string[], depth = 0): Extraction {
  if (Array.isArray(input)) return { rows: input, shape: "array" };
  if (!isRecord(input) || depth > 4) return { rows: [], shape: "unknown", issue: "expected an array or a recognized object wrapper" };

  const names = new Set(rowNameAliases.map(normalizeKey));
  if (Object.keys(input).some((key) => names.has(normalizeKey(key)))) {
    return { rows: [input], shape: "single-row" };
  }

  const wrappers = new Set(wrapperAliases.map(normalizeKey));
  const candidates = Object.keys(input)
    .filter((key) => wrappers.has(normalizeKey(key)))
    .map((key) => extractRows(input[key], rowNameAliases, wrapperAliases, depth + 1))
    .filter((result) => result.shape !== "unknown");
  if (candidates.length === 1) {
    return { ...candidates[0], shape: candidates[0].shape === "array" ? "wrapped-array" : candidates[0].shape };
  }
  if (candidates.length > 1) return { rows: [], shape: "unknown", issue: "multiple recognized collection wrappers; refusing to choose one" };
  return { rows: [], shape: "unknown", issue: "no recognized collection wrapper or row identity field" };
}

function normalizeRows<T>(input: unknown, rowNameAliases: string[], wrapperAliases: string[], parse: (row: unknown) => T): NormalizedCollection<T> {
  const extracted = extractRows(input, rowNameAliases, wrapperAliases);
  const issues: string[] = extracted.issue ? [extracted.issue] : [];
  const rows = extracted.rows.map((row, index) => {
    if (!isRecord(row)) issues.push(`row ${index} is not an object; its raw value is retained`);
    return parse(row);
  });
  return { rows, shape: extracted.shape, raw: input, issues };
}

function parseLight(row: unknown): NormalizedLight {
  const r = isRecord(row) ? row : {};
  return {
    name: observe<string>(r, "Name", "string"),
    zoneParent: observe<string>(r, "ZoneParent", "string"),
    lightType: observe<string>(r, "LightType", "string"),
    group: observe<string>(r, "Group", "string"),
    x: observe<number>(r, "X", "number"),
    y: observe<number>(r, "Y", "number"),
    rotation: observe<number>(r, "Rotation", "number"),
    scale: observe<number>(r, "Scale", "number"),
    intensity: observe<number>(r, "Intensity", "number"),
    isOn: observe<boolean>(r, "IsOn", "boolean"),
    colorR: observe<number>(r, "colorR", "number"),
    colorG: observe<number>(r, "colorG", "number"),
    colorB: observe<number>(r, "colorB", "number"),
    usageCounter: observe<number>(r, "UsageCounter", "number"),
    broken: observe<boolean>(r, "Broken", "boolean"),
    isUnderMaintenance: observe<boolean>(r, "IsUnderMaintenance", "boolean"),
    raw: row,
  };
}

function parseFan(row: unknown): NormalizedExhaustFan {
  const r = isRecord(row) ? row : {};
  return {
    name: observe<string>(r, "Name", "string"),
    zoneParent: observe<string>(r, "ZoneParent", "string"),
    x: observe<number>(r, "X", "number"),
    y: observe<number>(r, "Y", "number"),
    rotation: observe<number>(r, "Rotation", "number"),
    fumeIntensity: observe<number>(r, "FumeIntensity", "number"),
    isOn: observe<boolean>(r, "IsOn", "boolean"),
    isRepairRequested: observe<boolean>(r, "IsRepairRequested", "boolean"),
    repairProgress: observe<number>(r, "RepairProgress", "number"),
    usageCounter: observe<number>(r, "UsageCounter", "number"),
    broken: observe<boolean>(r, "Broken", "boolean"),
    isUnderMaintenance: observe<boolean>(r, "IsUnderMaintenance", "boolean"),
    raw: row,
  };
}

function parseZone(row: unknown): NormalizedZone {
  const r = isRecord(row) ? row : {};
  return {
    name: observe<string>(r, "Name", "string"),
    zoneType: observe<string>(r, "ZoneType", "string"),
    x: observe<number>(r, "X", "number"),
    y: observe<number>(r, "Y", "number"),
    rotation: observe<number>(r, "Rotation", "number"),
    width: observe<number>(r, "Width", "number"),
    height: observe<number>(r, "Height", "number"),
    carbonMonoxideLevel: observe<number>(r, "CarbonMonoxideLevel", "number"),
    dangerLevel: observe<string>(r, "DangerLevel", "string"),
    raw: row,
  };
}

const LIGHT_WRAPPERS = ["data", "items", "results", "values", "lights", "light"];
const FAN_WRAPPERS = ["data", "items", "results", "values", "exhaustFans", "exhaustFan", "fans", "fan"];
const ZONE_WRAPPERS = ["data", "items", "results", "values", "zones", "zone"];

/** Parse a Level 2 `list-lights` value without inventing defaults for missing fields. */
export function parseLights(input: unknown): NormalizedCollection<NormalizedLight> {
  return normalizeRows(input, ["Name"], LIGHT_WRAPPERS, parseLight);
}

/** Parse a Level 2 `list-exhaust-fans` value without conflating repair request and failure. */
export function parseExhaustFans(input: unknown): NormalizedCollection<NormalizedExhaustFan> {
  return normalizeRows(input, ["Name"], FAN_WRAPPERS, parseFan);
}

/** Parse a Level 2 `list-zones` value; CO fields stay unavailable unless actually supplied. */
export function parseZones(input: unknown): NormalizedCollection<NormalizedZone> {
  return normalizeRows(input, ["Name"], ZONE_WRAPPERS, parseZone);
}

/** Normalize only the CO fields evidenced in the webhook contract/log renderer. */
export function parseCarbonMonoxideEvent(input: unknown): NormalizedCarbonMonoxideEvent {
  const r = isRecord(input) ? input : {};
  const eventClass = observe<string>(r, "EventClass", "string");
  return {
    eventClass,
    eventId: observe<string>(r, "EventId", "string"),
    sequenceId: observe<string>(r, "SequenceId", "string"),
    serverDateTime: observe<string>(r, "ServerDateTime", "string"),
    zoneName: observe<string>(r, "ZoneName", "string"),
    carbonMonoxideLevel: observe<number>(r, "CarbonMonoxideLevel", "number"),
    dangerLevel: observe<string>(r, "DangerLevel", "string"),
    isCarbonMonoxideEvent: eventClass.available && eventClass.value === EventClass.CarbonMonoxide,
    raw: input,
  };
}
