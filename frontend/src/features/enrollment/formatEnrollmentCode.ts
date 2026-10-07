/** Pretty-print a 6-digit enrollment code for display (e.g. aloud). */
export function formatEnrollmentOtp6(token: string): string {
  const d = token.replace(/\D/g, "");
  if (d.length === 6) return `${d.slice(0, 3)} ${d.slice(3)}`;
  return token;
}
