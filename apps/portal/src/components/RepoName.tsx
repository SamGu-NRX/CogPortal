/**
 * A GitHub `owner/name` that wraps after the slash before it splits a word.
 *
 * Repository names used `break-all`, which lets the browser cut at any
 * letter: the Runs page showed "cogworks-demo/ux-all-fail" with "ed" on the
 * next line (stranger walk r1, 3 Oct 2026). `overflow-wrap: anywhere` only
 * splits a segment that can't fit on a line by itself, so the slash and the
 * hyphens are tried first.
 */
export function RepoName({ fullName }: { fullName: string }) {
  const slash = fullName.indexOf("/");
  return (
    <span className="[overflow-wrap:anywhere]">
      {slash === -1 ? (
        fullName
      ) : (
        <>
          {fullName.slice(0, slash + 1)}
          <wbr />
          {fullName.slice(slash + 1)}
        </>
      )}
    </span>
  );
}
