import { pickEntryModule } from "./lib/activity-runtime";

if (pickEntryModule(window.location.hostname, window.location.search) === "activity") {
  void import("./activity-main");
} else {
  void import("./main");
}
