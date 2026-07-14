export interface CogportalMetadata {
  name?: string;
  description?: string;
}

function withoutComment(line: string): string {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\" && quoted) {
      escaped = true;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "#" && !quoted) {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseString(value: string): string {
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "string") throw new Error("Expected a TOML string.");
  return parsed;
}

function parseMembers(value: string): void {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || !parsed.every((member) => typeof member === "string")) {
    throw new Error("Expected an array of GitHub logins.");
  }
  for (const member of parsed.slice(0, 8)) {
    if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(member)) {
      throw new Error("Expected a GitHub login.");
    }
  }
}

function displayText(value: string, maximum: number): string | undefined {
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
  const limited = Array.from(clean).slice(0, maximum).join("");
  return limited || undefined;
}

export function parseCogportalToml(input: string): CogportalMetadata {
  try {
    let section = "";
    let schemaVersion = false;
    let name: string | undefined;
    let description: string | undefined;

    for (const sourceLine of input.split(/\r?\n/)) {
      const line = withoutComment(sourceLine).trim();
      if (!line) continue;
      const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
      if (sectionMatch) {
        section = sectionMatch[1]?.trim() ?? "";
        continue;
      }
      const assignment = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
      if (!assignment) throw new Error("Invalid TOML assignment.");
      const key = assignment[1];
      const value = assignment[2];
      if (!key || !value) throw new Error("Invalid TOML assignment.");

      if (section === "" && key === "schema_version") {
        if (value !== "1") throw new Error("Unsupported schema version.");
        schemaVersion = true;
      } else if (section === "team" && key === "name") {
        name = displayText(parseString(value), 60);
      } else if (section === "team" && key === "description") {
        description = displayText(parseString(value), 280);
      } else if (section === "team" && key === "members") {
        parseMembers(value);
      }
    }

    return schemaVersion ? { ...(name ? { name } : {}), ...(description ? { description } : {}) } : {};
  } catch {
    return {};
  }
}
