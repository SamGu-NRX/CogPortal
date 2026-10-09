// Thin CLI around register-commands-lib.mjs; every contract lives there.
// An uncaught error from top-level await exits 1 with the message printed.
import { registerCommands } from "./register-commands-lib.mjs";

await registerCommands({ env: process.env, fetchImpl: fetch, log: console.log });
