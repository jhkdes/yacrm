"use client";

import { useFormStatus } from "react-dom";

// Second client component in the app (after CopyButton.tsx), same narrow-leaf
// pattern — useFormStatus only works inside a form's own child component,
// not the server-rendered form itself, so this can't be inlined into
// page.tsx without turning the whole page client-side. A large real export
// (M28's perf fix aside) can still take real time, and a plain form post
// gives zero feedback while it runs — this is the difference between "still
// working" and "did this hang" that was otherwise invisible.
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
