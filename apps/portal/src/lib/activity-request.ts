import { z } from "zod";
import { ActivityRequestError } from "./activity-gate";

export async function activityJsonRequest<T>(
  apiPrefix: string,
  path: string,
  schema: z.ZodType<T>,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(`${apiPrefix}${path}`, {
    method: init?.method ?? "GET",
    credentials: "same-origin",
    headers: {
      "X-Cog-Activity": "1",
      ...((init?.body !== undefined || init?.method === "POST") ? { "Content-Type": "application/json" } : {}),
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) {
    let message = "The live bench could not be reached.";
    try {
      const body = z.object({ error: z.object({ message: z.string() }) }).parse(await response.json());
      message = body.error.message;
    } catch {
      // Use the calm fallback above.
    }
    throw new ActivityRequestError(response.status, message);
  }
  return schema.parse(await response.json());
}

