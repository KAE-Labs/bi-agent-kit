import crypto from "node:crypto";

function canonicalize(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((key) => JSON.stringify(key) + ":" + canonicalize(value[key]));
  return "{" + parts.join(",") + "}";
}

export function hashValue(value) {
  const canonical = canonicalize(value);
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}
