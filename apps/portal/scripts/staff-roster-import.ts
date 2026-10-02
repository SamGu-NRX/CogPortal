// Print the one-time staff roster import as SQL. Why it exists, and why it
// runs once and by hand: worker/auth/staff-import.ts. Steps:
// docs/how-to/deploy-your-own.md, "Moving the staff roster", which also says
// when not to run it.
//
//   printf '%s' "$PLATFORM_STAFF_LOGINS" |
//     pnpm --filter @cogworks/portal exec tsx scripts/staff-roster-import.ts \
//       --owners "$PLATFORM_OWNER_LOGINS" > staff-import.sql
import { readFileSync } from "node:fs";
import { StaffImportError, staffImportSql } from "../worker/auth/staff-import";

const flag = process.argv.indexOf("--owners");
const owners = flag === -1 ? undefined : process.argv[flag + 1];
if (owners === undefined || process.argv.length !== 4) {
  process.stderr.write("usage: <roster on stdin> | tsx scripts/staff-roster-import.ts --owners <owner logins>\n");
  process.exit(2);
}
try {
  process.stdout.write(staffImportSql(readFileSync(0, "utf8"), owners, Date.now()));
} catch (error) {
  if (!(error instanceof StaffImportError)) throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
