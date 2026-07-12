import { parse, modify, applyEdits } from "jsonc-parser";

const FORMATTING_OPTIONS = { tabSize: 2, insertSpaces: true, eol: "\n" };

export class MalformedConfigError extends Error {
  constructor(detail) {
    super("Config file content is not valid JSON: " + detail);
    this.name = "MalformedConfigError";
  }
}

function parseStrict(fileText) {
  if (fileText.charCodeAt(0) === 0xfeff) fileText = fileText.slice(1);
  const errors = [];
  const parsed = parse(fileText, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    throw new MalformedConfigError("parse error code " + errors[0].error + " at offset " + errors[0].offset);
  }
  return parsed;
}

export function readJsonServers(fileText, rootKey) {
  if (!fileText || fileText.trim().length === 0) return {};
  const parsed = parseStrict(fileText);
  if (!parsed || typeof parsed !== "object") return {};
  const servers = parsed[rootKey];
  if (!servers || typeof servers !== "object") return {};
  return servers;
}

export function setJsonServer(fileText, rootKey, serverKey, serverValue) {
  const base = fileText && fileText.trim().length > 0 ? fileText : "{}\n";
  const edits = modify(base, [rootKey, serverKey], serverValue, {
    formattingOptions: FORMATTING_OPTIONS,
  });
  return applyEdits(base, edits);
}

export function removeJsonServer(fileText, rootKey, serverKey) {
  if (!fileText) return fileText;
  const edits = modify(fileText, [rootKey, serverKey], undefined, {
    formattingOptions: FORMATTING_OPTIONS,
  });
  return applyEdits(fileText, edits);
}
