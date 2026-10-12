/** Control-plane client for the egress witness (support/egress.mjs). */

import { readFileSync } from "node:fs";

export interface EgressEvent {
  seq: number;
  at: string;
  mode: string;
  kind: string;
  method?: string;
  host?: string;
  port?: number;
  path?: string;
  status?: number;
  allowed?: boolean;
  refused?: string;
  bytes?: number;
  sent?: number;
  received?: number;
  error?: string;
}

export interface EgressInfo {
  proxy: string;
  control: string;
  log: string;
  pid: number;
}

export function egressInfo(): EgressInfo {
  return JSON.parse(readFileSync(env("EGRESS_INFO"), "utf8"));
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`required environment variable ${name} is not set`);
  return value;
}

async function control(request: { path: string; body?: unknown }): Promise<any> {
  const { control: base } = egressInfo();
  const response = await fetch(`${base}${request.path}`, {
    method: request.body === undefined ? "GET" : "POST",
    headers: request.body === undefined ? undefined : { "content-type": "application/json" },
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
  });
  if (!response.ok) throw new Error(`egress control ${request.path} failed: ${response.status} ${await response.text()}`);
  return response.json();
}

/** Flip the witness between online and offline. The mode is recorded on
 * events (the journeys use it to mark which windows must be silent); the
 * enforcement is fail closed in both modes: loopback and the documented
 * public-asset hosts only, refused pre-connect everywhere else. */
export async function setEgressMode(mode: "online" | "offline"): Promise<void> {
  await control({ path: "/__egress__/mode", body: { mode } });
}

/** Remember the log position before a case's traffic; readEvents(after). */
export async function placeEgressMarker(label: string): Promise<number> {
  const result = await control({ path: "/__egress__/marker", body: { label } });
  return result.seq as number;
}

/** Every request the witness saw after the marker. */
export async function readEgressEvents(after: number): Promise<EgressEvent[]> {
  const result = await control({ path: `/__egress__/events?after=${after}` });
  return result.events as EgressEvent[];
}
