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

  // 1) Prefer a token of the exact TAN length (e.g. 6 digits).
  const exact = tokens.filter((t) => t.length === expectedLen);
  if (exact.length === 1) return exact[0] ?? null;
  if (exact.length > 1) return exact[exact.length - 1] ?? null; // ambiguous → newest; caller should flag

  // 2) Fallback: longest token in the bank-OTP range (4-8 digits).
  // We CAP at 8 to exclude 10+ digit timestamps / reference numbers that the
  // boss's phone also extracts and forwards alongside the real OTP. NMB SMS
  // commonly carries a 13-digit epoch reference that used to win this fallback
  // and get typed into the OTP box, which the bank then rejected.
  const byLen = tokens
    .filter((t) => t.length >= 4 && t.length <= 8)
    .sort((a, b) => b.length - a.length);
  return byLen[0] ?? null;
}
