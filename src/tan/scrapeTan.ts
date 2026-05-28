/**
 * Scrapes the CRDB TAN/OTP out of the phone app's "numbers + emojis" forwarded
 * format (see MoneyAlert SmsReceiver.extractNumbers). The phone never sends the
 * raw bank SMS — only this formatted string — so we parse the code from here.
 *
 * Real sample (confirmed 2026-05-20):
 *   "852456 ⚡\n05:00 🌟"   → "852456"   (852456 = TAN, 05:00 = validity timer)
 *
 * The TAN is a fixed-length digit run (CRDB = 6). The other tokens are noise:
 * the validity countdown ("05:00" → "0500") or a "5 minutes" style number.
 */
export function scrapeTan(forwarded: string, expectedLen = 6): string | null {
  const tokens = forwarded
    .split(/\s+/) // break on spaces / newlines
    .map((t) => t.replace(/\D/g, "")) // keep digits only → emojis & ':' vanish
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return null;

  // OTPs in this system are 4-7 digits and ALWAYS appear before any reference
  // number or timestamp in the bank SMS. The boss's phone extracts every
  // number from the SMS in the order it appears, so the first 4-7 digit token
  // is the OTP. Anything longer than 7 digits (13-digit epoch refs, account
  // numbers, etc.) is excluded.
  const candidates = tokens.filter((t) => t.length >= 4 && t.length <= 7);
  if (candidates.length === 0) return null;

  // 1) Prefer the FIRST token of the exact expected length (CRDB sends a
  //    clean 6-digit OTP; that wins immediately).
  const exact = candidates.find((t) => t.length === expectedLen);
  if (exact) return exact;

  // 2) Fallback: the FIRST candidate (NMB's 5-digit OTP wins here cleanly
  //    even though TAN_LENGTH is set to 6 for CRDB).
  return candidates[0] ?? null;
}
