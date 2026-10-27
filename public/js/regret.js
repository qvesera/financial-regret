/** Regret metric — pure functions, no DOM. Testable with node --test. */

/**
 * Compute regret KPIs from a normalised game list.
 *
 * @param {Array<{id:string, name:string, platform:string, price:number|null, hours:number|null, paid:number|null}>} games
 * @param {"price"|"paid"} basis - which cost column to use
 * @returns {{libraryValue:number, backlogValue:number, regretScore:number|null, valuePerHour:number|null, coverage:number|null, knownCount:number, unknownCount:number, estimatedCount:number}}
 */
export function computeRegret(games, basis = "price") {
  const known = games.filter((g) => g.hours != null);
  const unknown = games.filter((g) => g.hours == null);

  const cost = (g) => {
    if (basis === "paid" && g.paid != null) return g.paid;
    return g.price;
  };

  const libraryValue = games.reduce((sum, g) => sum + (cost(g) || 0), 0);
  const knownValue = known.reduce((sum, g) => sum + (cost(g) || 0), 0);
  const backlogValue = known
    .filter((g) => g.hours < 1)
    .reduce((sum, g) => sum + (cost(g) || 0), 0);

  const played = known.filter((g) => g.hours > 0);
  const playedCost = played.reduce((sum, g) => sum + (cost(g) || 0), 0);
  const playedHours = played.reduce((sum, g) => sum + g.hours, 0);

  const regretScore = knownValue ? backlogValue / knownValue : null;
  const valuePerHour = playedHours ? playedCost / playedHours : null;
  const coverage = libraryValue ? knownValue / libraryValue : null;

  const estimatedCount = basis === "paid"
    ? games.filter((g) => g.paid == null && g.price != null).length
    : 0;

  return {
    libraryValue,
    backlogValue,
    regretScore,
    valuePerHour,
    coverage,
    knownCount: known.length,
    unknownCount: unknown.length,
    estimatedCount,
  };
}

/**
 * Per-row regret sorting key: price desc (default).
 */
export function sortByPriceDesc(a, b) {
  const pa = a.price ?? 0;
  const pb = b.price ?? 0;
  return pb - pa;
}
