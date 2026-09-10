"use client";

import { useState } from "react";

interface CandidateDrawerTriggerProps {
  name: string;
  standardizedTitle: string | null;
  company: string | null;
  seniority: string | null;
  function: string | null;
  industry: string | null;
  lastInteractionAt: Date | null;
  linkedinProfileUrl: string;
}

// This app's 4th client component (after CopyButton.tsx,
// ImportSubmitButton.tsx, LinkedInConnectionsImportForm.tsx), same
// narrow-leaf pattern — one instance per table row, each owning its own
// open/closed state, rather than one client component wrapping the whole
// table. The table's checkboxes stay part of the server-rendered POST
// form exactly as M32 built them; only this detail panel needs client
// state. LinkedIn can't be embedded in-app (it blocks iframing), so
// "Open LinkedIn" is a plain new-tab link, not an in-app view.
export function CandidateDrawerTrigger(props: CandidateDrawerTriggerProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Details
      </button>
      {open && (
        <div
          role="dialog"
          aria-label={`Details for ${props.name}`}
          style={{
            position: "fixed",
            top: 0,
            right: 0,
            bottom: 0,
            width: "22rem",
            maxWidth: "90vw",
            background: "white",
            borderLeft: "1px solid #ccc",
            boxShadow: "-2px 0 8px rgba(0,0,0,0.15)",
            padding: "1.5rem",
            overflowY: "auto",
            zIndex: 1000,
          }}
        >
          <button
            type="button"
            onClick={() => setOpen(false)}
            style={{ float: "right" }}
            aria-label="Close"
          >
            ×
          </button>
          <h3 style={{ marginTop: 0 }}>{props.name}</h3>
          <dl>
            <dt style={{ fontWeight: "bold" }}>Title</dt>
            <dd>{props.standardizedTitle ?? "—"}</dd>
            <dt style={{ fontWeight: "bold" }}>Company</dt>
            <dd>{props.company ?? "—"}</dd>
            <dt style={{ fontWeight: "bold" }}>Seniority</dt>
            <dd>{props.seniority ?? "—"}</dd>
            <dt style={{ fontWeight: "bold" }}>Function</dt>
            <dd>{props.function ?? "—"}</dd>
            <dt style={{ fontWeight: "bold" }}>Industry</dt>
            <dd>{props.industry ?? "—"}</dd>
            <dt style={{ fontWeight: "bold" }}>Last interaction</dt>
            <dd>{props.lastInteractionAt ? props.lastInteractionAt.toISOString().slice(0, 10) : "—"}</dd>
          </dl>
          <p>
            <a href={props.linkedinProfileUrl} target="_blank" rel="noopener noreferrer">
              Open LinkedIn ↗
            </a>
          </p>
        </div>
      )}
    </>
  );
}
