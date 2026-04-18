function getDigestKey(now = new Date()) {
  const copy = new Date(now);
  copy.setUTCHours(0, 0, 0, 0);
  const day = copy.getUTCDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;
  copy.setUTCDate(copy.getUTCDate() + diffToMonday);
  return copy.toISOString().slice(0, 10);
}

module.exports = { getDigestKey };
