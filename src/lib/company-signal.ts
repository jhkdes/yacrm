// Free/personal email providers — never treated as a company signal, no
// matter how many Contacts use them. Not exhaustive, just the common ones;
// REQUIREMENTS.md is explicit that domain is a signal, not a hard filter,
// so under-covering here just means a missed signal, not a wrong exclusion.
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "yahoo.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "mail.com",
  "gmx.com",
  "yandex.com",
  "zoho.com",
]);

export interface ContactForCompanySignal {
  source: string;
  sourceIdentifier: string;
}

function emailDomain(identifier: string): string | null {
  const atIndex = identifier.indexOf("@");
  return atIndex === -1 ? null : identifier.slice(atIndex + 1).toLowerCase();
}

// Distinct, non-free-mail domains found across a Person's email Contacts —
// a signal they may work at that company, not proof (the same Person may
// also have a personal-address Contact, and this doesn't try to reconcile
// the two).
export function inferCompanyDomains(
  contacts: ContactForCompanySignal[],
): string[] {
  const domains = new Set<string>();
  for (const c of contacts) {
    if (c.source !== "gmail" && c.source !== "hotmail") continue;
    const domain = emailDomain(c.sourceIdentifier);
    if (domain && !FREE_EMAIL_DOMAINS.has(domain)) {
      domains.add(domain);
    }
  }
  return [...domains].sort();
}
