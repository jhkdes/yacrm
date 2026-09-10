"use client";

import { useFormStatus } from "react-dom";

// One of this app's client components (alongside CopyButton.tsx and the
// larger LinkedInConnectionsImportForm.tsx), same narrow-leaf pattern —
// useFormStatus only works inside a form's own child component, not the
// server-rendered form itself, so this can't be inlined into page.tsx
// without turning the whole page client-side. Now only used by the
// messages-import form (the connections form moved to its own
// batch-driven progress UI in LinkedInConnectionsImportForm.tsx, which
// needs real progress state, not just a binary pending flag). A large
// real export can still take real time, and a plain form post gives zero
// feedback while it runs — this is the difference between "still working"
// and "did this hang" that was otherwise invisible.
export function ImportSubmitButton() {
  const { pending } = useFormStatus();

  return (
    <p>
      <button type="submit" disabled={pending}>
        {pending ? "Importing…" : "Import"}
      </button>
      {pending && (
        <span style={{ marginLeft: "0.5rem", color: "#555" }}>
          Processing — large exports can take a few minutes, please don&apos;t
          close this tab.
        </span>
      )}
    </p>
  );
}
