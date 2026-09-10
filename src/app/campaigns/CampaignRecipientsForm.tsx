"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { processCampaignRecipientsBatchAction } from "@/app/actions";
import { sortFilterResults, type FilterResult, type SortField } from "@/lib/candidate-filter";

import { CandidateDrawerTrigger } from "./CandidateDrawerTrigger";

const CAMPAIGN_RECIPIENT_BATCH_SIZE = 2;

interface CampaignRecipientsFormProps {
  results: FilterResult[];
  targetCampaign: { id: number; name: string } | null;
  goal?: string;
  // Only seeds the initial arrow/order (e.g. a bookmarked URL with sort
  // params already in it) — every click after that re-sorts client-side,
  // see the note on `sort` state below for why.
  initialSort?: SortField;
  initialDir?: "asc" | "desc";
}

type State =
  | { phase: "idle" }
  | {
      phase: "running";
      batchIndex: number;
      totalBatches: number;
      added: number;
      skippedNoContactForChannel: number;
      skippedDraftFailed: number;
      skippedAlreadyRecipient: number;
    }
  | {
      phase: "error";
      message: string;
      batchesDone: number;
      added: number;
      skippedNoContactForChannel: number;
      skippedDraftFailed: number;
      skippedAlreadyRecipient: number;
    };

const SORT_FIELDS: { field: SortField; label: string }[] = [
  { field: "name", label: "Name" },
  { field: "title", label: "Title" },
  { field: "company", label: "Company" },
  { field: "seniority", label: "Seniority" },
  { field: "function", label: "Function" },
  { field: "industry", label: "Industry" },
  { field: "lastInteraction", label: "Last interaction" },
];

// This app's 5th client component, joining LinkedInConnectionsImportForm.tsx
// as the second whose client boundary covers a whole form rather than a
// narrow leaf — campaign creation drafts one message per selected person via
// a real Anthropic call each, so a single all-at-once submit gives no
// feedback for anything but a tiny list. Mirrors that component's pattern:
// read the form once, loop calling a batch Server Action, update progress
// state between calls, and on a systemic failure stop immediately rather
// than retry (per-person draft failures already don't throw — addRecipients
// just counts them as skipped and keeps going within a batch).
export function CampaignRecipientsForm({
  results,
  targetCampaign,
  goal,
  initialSort,
  initialDir,
}: CampaignRecipientsFormProps) {
  const router = useRouter();
  const [state, setState] = useState<State>({ phase: "idle" });
  // Sorting a column used to be a plain link to a new URL — a full page
  // navigation, which silently discarded whatever the user had typed into
  // the campaign name/goal/destination fields below (a real bug report:
  // sorting mid-way through filling out the form wiped that text). Sorting
  // the already-loaded `results` client-side instead means no navigation
  // ever happens, so nothing in the form below can be reset by it.
  const [sort, setSort] = useState<{ field: SortField; dir: "asc" | "desc" } | null>(
    initialSort ? { field: initialSort, dir: initialDir === "desc" ? "desc" : "asc" } : null,
  );

  const displayedResults = sort ? sortFilterResults(results, sort.field, sort.dir) : results;

  function handleSortClick(field: SortField) {
    setSort((prev) => {
      const isActive = prev?.field === field;
      const nextDir = isActive && prev.dir !== "desc" ? "desc" : "asc";
      return { field, dir: nextDir };
    });
  }

  function sortIndicator(field: SortField): string {
    if (sort?.field !== field) return "";
    return sort.dir === "desc" ? " ▼" : " ▲";
  }

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);

    const personIds = formData
      .getAll("personIds")
      .map((v) => Number(v))
      .filter((n) => Number.isInteger(n));
    if (personIds.length === 0) return;

    const channel = formData.get("channel") as "email" | "linkedin";
    const name = targetCampaign ? undefined : (formData.get("name") as string);
    const goal = targetCampaign ? undefined : (formData.get("goal") as string);
    const destinationUrl = targetCampaign
      ? undefined
      : (formData.get("destinationUrl") as string);

    const batches: number[][] = [];
    for (let i = 0; i < personIds.length; i += CAMPAIGN_RECIPIENT_BATCH_SIZE) {
      batches.push(personIds.slice(i, i + CAMPAIGN_RECIPIENT_BATCH_SIZE));
    }

    setState({
      phase: "running",
      batchIndex: 0,
      totalBatches: batches.length,
      added: 0,
      skippedNoContactForChannel: 0,
      skippedDraftFailed: 0,
      skippedAlreadyRecipient: 0,
    });

    let campaignId = targetCampaign?.id;
    let added = 0;
    let skippedNoContactForChannel = 0;
    let skippedDraftFailed = 0;
    let skippedAlreadyRecipient = 0;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
      const result = await processCampaignRecipientsBatchAction({
        name: batchIndex === 0 ? name : undefined,
        goal: batchIndex === 0 ? goal : undefined,
        destinationUrl: batchIndex === 0 ? destinationUrl : undefined,
        campaignId,
        channel,
        personIds: batches[batchIndex],
      });

      if (!result.ok) {
        setState({
          phase: "error",
          message: result.message,
          batchesDone: batchIndex,
          added,
          skippedNoContactForChannel,
          skippedDraftFailed,
          skippedAlreadyRecipient,
        });
        return;
      }

      campaignId = result.campaignId;
      added += result.added;
      skippedNoContactForChannel += result.skippedNoContactForChannel;
      skippedDraftFailed += result.skippedDraftFailed;
      skippedAlreadyRecipient += result.skippedAlreadyRecipient;

      const isLastBatch = batchIndex + 1 === batches.length;
      if (isLastBatch) {
        router.push(
          `/campaigns/${campaignId}?${new URLSearchParams({
            added: String(added),
            skipped_no_contact: String(skippedNoContactForChannel),
            skipped_draft_failed: String(skippedDraftFailed),
            skipped_already: String(skippedAlreadyRecipient),
          }).toString()}`,
        );
        return;
      }

      setState({
        phase: "running",
        batchIndex: batchIndex + 1,
        totalBatches: batches.length,
        added,
        skippedNoContactForChannel,
        skippedDraftFailed,
        skippedAlreadyRecipient,
      });
    }
  }

  const isRunning = state.phase === "running";

  return (
    <form onSubmit={handleSubmit}>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th></th>
              {SORT_FIELDS.map(({ field, label }) => (
                <th key={field} style={{ textAlign: "left", padding: "0.25rem 0.5rem" }}>
                  <button
                    type="button"
                    onClick={() => handleSortClick(field)}
                    style={{
                      background: "none",
                      border: "none",
                      padding: 0,
                      font: "inherit",
                      color: "#06c",
                      textDecoration: "underline",
                      cursor: "pointer",
                    }}
                  >
                    {label}
                    {sortIndicator(field)}
                  </button>
                </th>
              ))}
              <th></th>
            </tr>
          </thead>
          <tbody>
            {displayedResults.map((r) => (
              <tr key={r.personId} style={{ borderTop: "1px solid #eee" }}>
                <td style={{ padding: "0.25rem 0.5rem" }}>
                  <input type="checkbox" name="personIds" value={r.personId} disabled={isRunning} />
                </td>
                <td style={{ padding: "0.25rem 0.5rem" }}>
                  <a href={`/people/${r.personId}`}>{r.name}</a>
                </td>
                <td style={{ padding: "0.25rem 0.5rem" }}>{r.standardizedTitle ?? "—"}</td>
                <td style={{ padding: "0.25rem 0.5rem" }}>{r.company ?? "—"}</td>
                <td style={{ padding: "0.25rem 0.5rem" }}>{r.seniority ?? "—"}</td>
                <td style={{ padding: "0.25rem 0.5rem" }}>{r.function ?? "—"}</td>
                <td style={{ padding: "0.25rem 0.5rem" }}>{r.industry ?? "—"}</td>
                <td style={{ padding: "0.25rem 0.5rem" }}>
                  {r.lastInteractionAt ? r.lastInteractionAt.toISOString().slice(0, 10) : "—"}
                </td>
                <td style={{ padding: "0.25rem 0.5rem" }}>
                  <CandidateDrawerTrigger
                    name={r.name}
                    standardizedTitle={r.standardizedTitle}
                    company={r.company}
                    seniority={r.seniority}
                    function={r.function}
                    industry={r.industry}
                    lastInteractionAt={r.lastInteractionAt}
                    linkedinProfileUrl={r.linkedinProfileUrl}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!targetCampaign && (
        <>
          <p>
            <label>
              Campaign name:{" "}
              <input
                type="text"
                name="name"
                placeholder="e.g. AI interview outreach — Sept"
                style={{ width: "24rem" }}
                required
                disabled={isRunning}
              />
            </label>
          </p>
          <p>
            <label>
              Campaign goal (used to draft each message, not for targeting):{" "}
              <input
                type="text"
                name="goal"
                defaultValue={goal ?? ""}
                placeholder="e.g. inviting them to try our AI interview study"
                style={{ width: "28rem" }}
                required
                disabled={isRunning}
              />
            </label>
          </p>
          <p>
            <label>
              Destination link (where a recipient&apos;s tracked link sends them, e.g. the AI
              interview study URL):{" "}
              <input
                type="url"
                name="destinationUrl"
                placeholder="https://..."
                style={{ width: "24rem" }}
                required
                disabled={isRunning}
              />
            </label>
          </p>
        </>
      )}
      <p>
        <label>
          Send via:{" "}
          <select name="channel" defaultValue="email" disabled={isRunning}>
            <option value="email">Email</option>
            <option value="linkedin">LinkedIn (copy-assist queue)</option>
          </select>
        </label>
      </p>
      <p>
        <button type="submit" disabled={isRunning}>
          {isRunning
            ? targetCampaign
              ? "Adding people…"
              : "Creating campaign…"
            : targetCampaign
              ? `Add checked people to ${targetCampaign.name}`
              : "Create campaign from checked people"}
        </button>
      </p>

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
                width: `${Math.round((state.batchIndex / state.totalBatches) * 100)}%`,
                height: "100%",
                background: "#3b82f6",
              }}
            />
          </div>
          <p style={{ color: "#555" }}>
            Drafting messages — batch {Math.min(state.batchIndex + 1, state.totalBatches)} of{" "}
            {state.totalBatches} ({state.added} added so far)
          </p>
        </div>
      )}

      {state.phase === "error" && (
        <div>
          <p style={{ color: "crimson" }}>Campaign recipients failed: {state.message}</p>
          {state.batchesDone > 0 && (
            <p style={{ color: "#555" }}>
              Processed {state.batchesDone} batch{state.batchesDone === 1 ? "" : "es"} ({state.added}{" "}
              recipient{state.added === 1 ? "" : "s"} added) before failing. Safe to fix the issue and
              re-submit with the same checked people — already-added recipients won&apos;t be
              duplicated.
            </p>
          )}
        </div>
      )}
    </form>
  );
}
