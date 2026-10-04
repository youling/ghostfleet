// Client-side view state only; this module never changes authoritative records.
export function selectRows(rows, options, adapter) {
  const query = String(options.query || "").trim().toLocaleLowerCase(options.locale);
  const filtered = rows.filter((row) =>
    (!query || String(adapter.searchText(row)).toLocaleLowerCase(options.locale).includes(query)) &&
    (!options.status || adapter.statusOf(row) === options.status) &&
    (!options.tab || options.tab === "all" || adapter.categoryOf(row) === options.tab));
  const collator = new Intl.Collator(options.locale || "en", { numeric: true, sensitivity: "base" });
  const direction = options.direction === "asc" ? 1 : -1;
  const sorted = filtered.slice().sort((a, b) => {
    const left = adapter.valueOf(a, options.sortKey), right = adapter.valueOf(b, options.sortKey);
    if (left == null && right == null) return 0;
    if (left == null) return 1;
    if (right == null) return -1;
    const order = typeof left === "number" && typeof right === "number" ? left - right : collator.compare(String(left), String(right));
    return order * direction;
  });
  const pageSize = [10, 25, 50].includes(Number(options.pageSize)) ? Number(options.pageSize) : 10;
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const requested = Number.isFinite(Number(options.page)) ? Math.trunc(Number(options.page)) : 1;
  const page = Math.max(1, Math.min(pages, requested));
  const start = (page - 1) * pageSize;
  return { rows: sorted.slice(start, start + pageSize), total: sorted.length, page, pages, pageSize, from: sorted.length ? start + 1 : 0, to: Math.min(start + pageSize, sorted.length) };
}
