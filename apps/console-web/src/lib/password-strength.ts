/** Local advice only: never use this grade as an authorization or save gate. */
export function passwordStrength(
  value: string,
): "Too easy" | "Medium" | "Strong" {
  const chars = Array.from(value),
    lower = value.toLowerCase().trim();
  const distinct = new Set(chars).size;
  const common =
    /^(password|qwerty|admin|welcome|letmein|test|abcd|iloveyou)[\d\W_]*$/i.test(
      lower,
    );
  const repeated = /^(.{1,4})\1+$/u.test(lower);
  const sequence = [
    "01234567890123456789",
    "abcdefghijklmnopqrstuvwxyz",
    "qwertyuiopasdfghjklzxcvbnm",
  ].some(
    (s) =>
      s.includes(lower) || Array.from(s).reverse().join("").includes(lower),
  );
  if (chars.length < 8 || distinct <= 2 || common || repeated || sequence)
    return "Too easy";
  const classes =
    [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9\s\u0080-\uFFFF]/].filter((r) =>
      r.test(value),
    ).length + (chars.some((c) => c.codePointAt(0)! > 127) ? 1 : 0);
  if (
    distinct >= 8 &&
    (chars.length >= 16 || (chars.length >= 12 && classes >= 3))
  )
    return "Strong";
  return "Medium";
}
export function sitePasswordIssue(value: string): string | undefined {
  const length = Array.from(value).length;
  if (length < 4) return "At least 4 characters.";
  if (length > 128) return "At most 128 characters.";
  if (
    Array.from(value).some((c) => {
      const cp = c.codePointAt(0)!;
      return (
        cp < 32 || (cp >= 127 && cp <= 159) || (cp >= 0xd800 && cp <= 0xdfff)
      );
    })
  )
    return "Use text without control characters or malformed Unicode.";
  return undefined;
}
