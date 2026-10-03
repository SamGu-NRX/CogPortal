import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  QueryClient,
  QueryClientProvider,
  type UseMutationResult,
} from "@tanstack/react-query";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

import { api } from "../src/lib/api.ts";
import { useStartPractice } from "../src/lib/queries.ts";

test("practice start stays pending until the dashboard invalidation finishes", async () => {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const originalStartPractice = api.startPractice;
  let mutation: UseMutationResult<
    { runId: string },
    Error,
    string | undefined
  > | null = null;
  let finishInvalidation!: () => void;
  let invalidationStarted!: () => void;
  const invalidation = new Promise<void>((resolve) => {
    finishInvalidation = resolve;
  });
  const enteredInvalidation = new Promise<void>((resolve) => {
    invalidationStarted = resolve;
  });

  api.startPractice = async () => ({ runId: "run_practice" });
  client.invalidateQueries = (() => {
    invalidationStarted();
    return invalidation;
  }) as QueryClient["invalidateQueries"];

  function Harness() {
    mutation = useStartPractice("vision-recognition");
    return null;
  }

  try {
    renderToStaticMarkup(
      React.createElement(
        QueryClientProvider,
        { client },
        React.createElement(Harness),
      ),
    );
    assert.ok(mutation);

    const request = mutation.mutateAsync("main");
    await enteredInvalidation;

    const activeMutation = client.getMutationCache().getAll().at(-1);
    assert.equal(activeMutation?.state.status, "pending");

    finishInvalidation();
    await request;
    assert.equal(activeMutation?.state.status, "success");
  } finally {
    api.startPractice = originalStartPractice;
    client.clear();
  }
});
