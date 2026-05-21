/**
 * Normalise a Tanzanian phone number to the LOCAL format the CRDB bulk file
 * expects (0XXXXXXXXX, 10 digits). The queue stores international (255…).
 *   255689013302 → 0689013302
 *   +255689013302 → 0689013302
 *   689013302     → 0689013302
 *   0689013302    → 0689013302 (unchanged)
 */
export function normalizePhone(raw: string): string {
  const d = (raw ?? "").replace(/\D/g, "");
  if (d.startsWith("255") && d.length === 12) return "0" + d.slice(3);
  if (d.startsWith("0") && d.length === 10) return d;
  if (d.length === 9) return "0" + d;
  return d; // best effort; caller/verification will catch anything malformed
}
