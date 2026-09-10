"use client";

import { useFormStatus } from "react-dom";

interface SubmitButtonProps {
  idleLabel: string;
  pendingLabel: string;
  pendingMessage?: string;
}

// Shared pending-state button for any form that can take real time (an
// LLM call per person, a large file upload, etc.) with no other feedback
// otherwise — the gap between "still working" and "did this hang" or "did
// I just create a duplicate by clicking twice" is exactly what this
// closes. useFormStatus only works inside a form's own child component,
// not the server-rendered form itself, so this has to be its own client
// component rather than inlined into a page — narrow-leaf, same pattern
// as this app's other client components (CopyButton, the LinkedIn import
// forms). Originally single-purpose as ImportSubmitButton; generalized
// here once a second, unrelated form (campaign creation) hit the same gap.
export function SubmitButton({ idleLabel, pendingLabel, pendingMessage }: SubmitButtonProps) {
  const { pending } = useFormStatus();

  return (
    <p>
      <button type="submit" disabled={pending}>
        {pending ? pendingLabel : idleLabel}
      </button>
      {pending && pendingMessage && (
        <span style={{ marginLeft: "0.5rem", color: "#555" }}>{pendingMessage}</span>
      )}
    </p>
  );
}
