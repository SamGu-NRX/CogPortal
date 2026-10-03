// React DOM decides when it is first imported whether text fields fire
// `input` events, and with no document yet it decides they don't, so typed
// text never reaches onChange under Happy DOM. Import this before React DOM
// in a test that types into a field. Each test still installs its own window.
import { Window } from "happy-dom";

const window = new Window();
for (const [key, value] of Object.entries({ window, document: window.document })) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
