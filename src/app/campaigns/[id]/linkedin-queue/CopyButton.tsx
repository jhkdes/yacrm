"use client";

import { useState } from "react";

// This app's first (and, deliberately, only) client component — clipboard
// access has no server-side equivalent. Everything else in the app is
// plain server components + form posts on purpose; keep it that way for
// anything that isn't inherently browser-only like this.
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? "Copied!" : "Copy message"}
    </button>
  );
}
