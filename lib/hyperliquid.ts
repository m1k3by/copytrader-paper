export async function hyperliquid<T>(body: object): Promise<T> {
  const res = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`hyperliquid ${res.status}: ${await res.text()}`);
  return res.json();
}
