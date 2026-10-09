## storage.py

Everything `cogbench` remembers between commands lives in one of two homes,
and both are plain JSON files and nothing else. Local reports collect in
`.cogbench/reports/` under the project a run happened in, one file per run
named after the report id (`local_<uuid>.json`), written by `save_report`
right after `execute` returns. `cogworks report` and `cogworks sync` read
them back, defaulting to `latest_report` when no path is given. The
linked-device credential lives in `~/.cogbench/config.json` instead,
overridable with `COGBENCH_CONFIG`, holding one token per portal plus
`activePortal`, so a single `cogworks link` covers every project on the
machine. Nothing else in the package writes a file, and nothing prunes old
reports; they accumulate until the student deletes them.

The credential file is written defensively because a torn write locks a
student out of every portal command. `save_token` serializes the whole
config, writes it to a `.tmp` file in the same directory, and swaps it into
place with `os.replace`, so the file on disk is always either the previous
config or the complete new one, never a half-written token. The directory
is set to mode 0700 and the file to 0600 where the OS honors POSIX modes;
a chmod failure is ignored rather than allowed to block linking. Reading is
strict: a config file that is not valid JSON raises `json.JSONDecodeError`
uncaught, and since that is a `ValueError`, the CLI reports it as a failed
command instead of a traceback. A missing file just reads as never linked.

One caveat to know before you change how reports are written:
`latest_report` picks the most recently modified `local_*.json` by
filesystem mtime, and the timestamps recorded inside a report are never
consulted. Copying a report into the directory, or touching an old one,
silently decides which run `cogworks report` shows and `cogworks sync`
sends.

Tokens are gated on their own clock: `token_for` returns the stored token
only when its `expiresAt` (milliseconds since epoch) is still in the
future, and `None` otherwise, which every caller reports as not linked.
`active_portal` is the same idea on the portal side, supplying the default
portal when the student names none.
