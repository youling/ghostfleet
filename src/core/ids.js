export function makeId(prefix) {
  return prefix + "-" + crypto.randomUUID();
}

export function isoNow(clock = Date) {
  return new clock().toISOString();
}

export function isoAfter(seconds, clock = Date) {
  return new clock(clock.now() + seconds * 1000).toISOString();
}
