export function pageOptions(uri: URL) {
  const limit = uri.searchParams.has("limit")
    ? Number(uri.searchParams.get("limit"))
    : undefined;
  if (
    limit !== undefined &&
    (!Number.isInteger(limit) || limit < 1 || limit > 100)
  ) throw new Error("limit must be an integer from 1 to 100.");
  return { cursor: uri.searchParams.get("cursor") ?? undefined, limit };
}
