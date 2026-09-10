"use client";

import { useState } from "react";

import { processLinkedInConnectionsBatchAction } from "@/app/actions";

type State =
  | { phase: "idle" }
  | {
      phase: "running";
      batchIndex: number;
      totalBatches: number;
      rowsDone: number;
      totalRows: number;
      created: number;
      classified: number;
      industriesInferred: number;
    }
  | {
      phase: "done";
      totalRows: number;
      rowsSkippedNoUrl: number;
      created: number;
      classified: number;
      industriesInferred: number;
    }
  | { phase: "error"; message: string; batchesDone: number; rowsDone: number };

// This app's third client component (after CopyButton.tsx and
// ImportSubmitButton.tsx), and its first with real state/a loop — the
// requirement (a live completion %) can't be shown by a redirect-based
// Server Action, which only resolves once, at the very end. This
// component reads the uploaded file to text once, then calls
// processLinkedInConnectionsBatchAction repeatedly (one call per
// CONNECTIONS_BATCH_SIZE-row batch), updating progress between calls. If
// a batch fails, the loop stops immediately — no retry, no skipping ahead
// — and the partial progress made so far stays visible in the error state.
export function LinkedInConnectionsImportForm() {
  const [state, setState] = useState<State>({ phase: "idle" });

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fileInput = form.elements.namedItem("file") as HTMLInputElement;
    const file = fileInput.files?.[0];
    if (!file) return;

    const csvText = await file.text();

    setState({
      phase: "running",
      batchIndex: 0,
      totalBatches: 1,
      rowsDone: 0,
      totalRows: 0,
      created: 0,
      classified: 0,
      industriesInferred: 0,
    });

    let rowsDone = 0;
    let created = 0;
    let classified = 0;
    let industriesInferred = 0;

    for (let batchIndex = 0; ; batchIndex += 1) {
      const result = await processLinkedInConnectionsBatchAction(csvText, batchIndex);

      if (!result.ok) {
        setState({
          phase: "error",
          message: result.message,
          batchesDone: batchIndex,
          rowsDone,
        });
        return;
      }

      rowsDone += result.summary.rowsProcessed;
      created += result.summary.contactsCreated;
      classified += result.summary.titlesClassified;
      industriesInferred += result.summary.industriesInferred;

      const isLastBatch = batchIndex + 1 === result.totalBatches;

      if (isLastBatch) {
        setState({
          phase: "done",
          totalRows: result.totalRows,
          rowsSkippedNoUrl: result.rowsSkippedNoUrl,
          created,
          classified,
          industriesInferred,
        });
        return;
      }

      setState({
        phase: "running",
        batchIndex,
        totalBatches: result.totalBatches,
        rowsDone,
        totalRows: result.totalRows,
        created,
        classified,
        industriesInferred,
      });
    }
  }

  const isRunning = state.phase === "running";

  return (
    <>
      <form onSubmit={handleSubmit}>
        <input type="file" name="file" accept=".csv" required disabled={isRunning} />
        <button type="submit" disabled={isRunning}>
          {isRunning ? "Importing…" : "Import"}
        </button>
      </form>

      {state.phase === "running" && (
        <div style={{ marginTop: "0.5rem" }}>
          <div
            style={{
              width: "24rem",
              maxWidth: "100%",
              height: "1rem",
              background: "#eee",
              borderRadius: "0.25rem",
              overflow: "hidden",
            }}
          >
            <div
              style={{
                width: `${Math.round(((state.batchIndex + 1) / state.totalBatches) * 100)}%`,
                height: "100%",
                background: "#3b82f6",
              }}
            />
          </div>
          <p style={{ color: "#555" }}>
            {state.totalRows > 0
              ? `${state.rowsDone} of ${state.totalRows} rows — batch ${state.batchIndex + 1} of ${state.totalBatches}`
              : "Starting…"}
          </p>
        </div>
      )}

      {state.phase === "done" && (
        <ul>
          <li>Rows processed: {state.totalRows}</li>
          <li>Rows skipped (no profile URL): {state.rowsSkippedNoUrl}</li>
          <li>New contacts created: {state.created}</li>
          <li>Titles classified: {state.classified}</li>
          <li>Industries inferred: {state.industriesInferred}</li>
        </ul>
      )}

      {state.phase === "error" && (
        <div>
          <p style={{ color: "crimson" }}>Import failed: {state.message}</p>
          {state.batchesDone > 0 && (
            <p style={{ color: "#555" }}>
              Processed {state.batchesDone} batch{state.batchesDone === 1 ? "" : "es"} ({state.rowsDone}{" "}
              row{state.rowsDone === 1 ? "" : "s"}) before failing. Already-imported people are safe to
              leave as-is — re-running the same file will pick up where it left off.
            </p>
          )}
        </div>
      )}
    </>
  );
}
