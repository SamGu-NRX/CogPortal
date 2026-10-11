#!/usr/bin/env python3
"""Dependency-free JSON Schema subset validator for the attribution inventory.

Supports exactly the keywords the committed schema uses: type, enum, const,
required, properties, additionalProperties, items, $ref/$defs, maxLength,
minItems, pattern. Returns a list of human-readable violation messages
(empty when the document validates). No third-party dependencies.
"""
from __future__ import annotations

import json
import re
import sys
from typing import Any, Dict, List, Optional

TYPES = {
    "object": dict,
    "array": list,
    "string": str,
    "boolean": bool,
    "integer": int,
    "number": (int, float),
}


def _type_of(value: Any) -> Optional[str]:
    for name, pytype in TYPES.items():
        if name == "integer" and isinstance(value, bool):
            continue
        if name == "number" and isinstance(value, bool):
            continue
        if isinstance(value, pytype):
            return name
    return None


def _validate(value: Any, schema: Dict[str, Any], root: Dict[str, Any], path: str,
              errors: List[str]) -> None:
    if "$ref" in schema:
        ref = schema["$ref"]
        if not ref.startswith("#/"):
            errors.append("{}: unsupported $ref {}".format(path, ref))
            return
        target: Any = root
        for part in ref[2:].split("/"):
            target = target[part]
        _validate(value, target, root, path, errors)
        return

    expected = schema.get("type")
    if expected is not None:
        actual = _type_of(value)
        if actual != expected:
            errors.append("{}: expected type {}, got {}".format(path, expected, actual))
            return

    if "const" in schema and value != schema["const"]:
        errors.append("{}: expected const {!r}, got {!r}".format(path, schema["const"], value))

    if "enum" in schema and value not in schema["enum"]:
        errors.append("{}: {!r} is not one of {}".format(path, value, schema["enum"]))

    if isinstance(value, str):
        if "maxLength" in schema and len(value) > schema["maxLength"]:
            errors.append("{}: string longer than {} characters".format(path, schema["maxLength"]))
        if "pattern" in schema and not re.search(schema["pattern"], value):
            errors.append("{}: {!r} does not match pattern {!r}".format(path, value, schema["pattern"]))

    if isinstance(value, dict):
        for name in schema.get("required", []):
            if name not in value:
                errors.append("{}: missing required property {!r}".format(path, name))
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            for name in value:
                if name not in properties:
                    errors.append("{}: additional property {!r} is not allowed".format(path, name))
        for name, sub_schema in properties.items():
            if name in value:
                _validate(value[name], sub_schema, root,
                          "{}.{}".format(path, name), errors)

    if isinstance(value, list):
        if "minItems" in schema and len(value) < schema["minItems"]:
            errors.append("{}: fewer than {} items".format(path, schema["minItems"]))
        item_schema = schema.get("items")
        if isinstance(item_schema, dict):
            for index, item in enumerate(value):
                _validate(item, item_schema, root, "{}[{}]".format(path, index), errors)


def validate(document: Any, schema: Dict[str, Any]) -> List[str]:
    """Return a list of violation messages; empty when the document validates."""
    errors: List[str] = []
    _validate(document, schema, schema, "$", errors)
    return errors


def main(argv: Optional[List[str]] = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 2:
        print("usage: validate.py DOCUMENT SCHEMA", file=sys.stderr)
        return 3
    with open(argv[0], encoding="utf-8") as handle:
        document = json.load(handle)
    with open(argv[1], encoding="utf-8") as handle:
        schema = json.load(handle)
    errors = validate(document, schema)
    for message in errors:
        print("schema violation: {}".format(message), file=sys.stderr)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
