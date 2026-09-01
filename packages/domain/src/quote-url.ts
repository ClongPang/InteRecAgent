import net from "node:net";

/** Accepts only public HTTPS merchant URLs. */
export function validatedQuoteWebUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const host = url.hostname.toLocaleLowerCase("en-US").replace(/\.$/u, "");
    if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0" || host === "::1" || net.isIP(host) !== 0) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}
