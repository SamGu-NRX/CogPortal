import { clientEnv } from "./env.client";

const parameters = new URLSearchParams(window.location.search);
const isActivity =
  window.location.hostname === clientEnv.VITE_ACTIVITY_HOSTNAME ||
  window.location.hostname.endsWith(".discordsays.com") ||
  parameters.has("frame_id");

if (isActivity) {
  void import("./activity-main");
} else {
  void import("./main");
}
