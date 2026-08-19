#!/usr/bin/env python3
"""Export one known Apple Note without mutating its source store."""

from __future__ import annotations

import gzip
import json
import shutil
import sqlite3
from pathlib import Path


STORE = Path("/Users/samgu/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite")
OUTPUT = Path("/Users/samgu/BWSI/2026/CogPortal/apple-note-analysis")
NOTE_DATA_PK = 38
NOTE_UUID = "F67729E8-4DD4-4BD0-A69A-A609F505AAA7"
ATTACHMENTS = [
    (
        "354BB0AD-A653-4ED0-A7F4-D47E7A256B8B",
        Path("/Users/samgu/Library/Group Containers/group.com.apple.notes/Accounts/52A7359B-35F2-4A2D-85DD-6C14B8BF8C8C/Media/67CA4ED1-DFB7-45E5-BCAA-D19B3C93EBEE/1_72CAF02C-5F83-452A-9B41-F5DE7A9F2DCA/Pasted Graphic.png"),
        "image-01.png",
    ),
    (
        "CD082623-4008-49D0-91AB-00217ED1FD72",
        Path("/Users/samgu/Library/Group Containers/group.com.apple.notes/Accounts/52A7359B-35F2-4A2D-85DD-6C14B8BF8C8C/Media/D0030833-A0AF-4112-B714-8FEFA22AC4C5/1_9E47C95A-8E8F-45BC-8125-ADE38A7633BD/Pasted Graphic.png"),
        "image-02.png",
    ),
]


def read_varint(data: bytes, offset: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while offset < len(data):
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if byte < 0x80:
            return value, offset
        shift += 7
    raise ValueError("unterminated protobuf varint")


def length_fields(data: bytes) -> dict[int, list[bytes]]:
    fields: dict[int, list[bytes]] = {}
    offset = 0
    while offset < len(data):
        tag, offset = read_varint(data, offset)
        field_number, wire_type = tag >> 3, tag & 7
        if wire_type == 0:
            _, offset = read_varint(data, offset)
        elif wire_type == 1:
            offset += 8
        elif wire_type == 2:
            size, offset = read_varint(data, offset)
            value = data[offset : offset + size]
            offset += size
            fields.setdefault(field_number, []).append(value)
        elif wire_type == 5:
            offset += 4
        else:
            raise ValueError(f"unsupported protobuf wire type: {wire_type}")
    return fields


def extract_text(blob: bytes) -> str:
    # Apple Notes body path: NoteStoreProto(2) -> document(3) -> noteText(2).
    level_1 = length_fields(gzip.decompress(blob))[2][0]
    level_2 = length_fields(level_1)[3][0]
    text = length_fields(level_2)[2][0].decode("utf-8")
    return text.replace("\u2028", "\n")


def main() -> None:
    uri = f"file:{STORE.as_posix()}?mode=ro"
    with sqlite3.connect(uri, uri=True) as connection:
        row = connection.execute(
            "SELECT ZDATA FROM ZICNOTEDATA WHERE Z_PK = ?", (NOTE_DATA_PK,)
        ).fetchone()
    if row is None:
        raise RuntimeError("target note body was not found")

    text = extract_text(row[0])
    parts = text.split("\ufffc")
    if len(parts) != len(ATTACHMENTS) + 1:
        raise RuntimeError("inline marker count does not match attachment count")

    assets = OUTPUT / "assets"
    assets.mkdir(parents=True, exist_ok=True)
    blocks: list[dict[str, object]] = []
    markdown: list[str] = []

    for index, part in enumerate(parts):
        if part:
            blocks.append({"order": len(blocks) + 1, "type": "text", "text": part})
            markdown.append(part)
        if index < len(ATTACHMENTS):
            attachment_uuid, source, filename = ATTACHMENTS[index]
            destination = assets / filename
            shutil.copy2(source, destination)
            blocks.append(
                {
                    "order": len(blocks) + 1,
                    "type": "image",
                    "attachment_uuid": attachment_uuid,
                    "path": f"assets/{filename}",
                    "media_type": "image/png",
                }
            )
            markdown.append(f"\n\n![Inline image {index + 1}](assets/{filename})\n\n")

    title, _, body = markdown[0].partition("\n")
    markdown[0] = f"# {title}\n\n{body.lstrip()}"
    document = {
        "schema": "ordered-note/v1",
        "source": {
            "application": "Apple Notes",
            "note_uuid": NOTE_UUID,
            "note_data_pk": NOTE_DATA_PK,
            "read_only": True,
        },
        "title": title,
        "blocks": blocks,
    }
    (OUTPUT / "note.md").write_text("".join(markdown).rstrip() + "\n", encoding="utf-8")
    (OUTPUT / "note.json").write_text(
        json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


if __name__ == "__main__":
    main()
