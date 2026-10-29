/** Regret metric — pure functions, no DOM. Testable with node --test. */

/**
 * Compute regret KPIs from a normalised game list.
 *
 * Add-ons (kind === "dlc") are pulled out first and reported separately as
 * dlcValue / dlcCount. They have no independent playtime — you play them inside
 * the base game — so folding them in would read as money spent on never-opened
 * titles and drag the backlog, regret score and quartile benchmark the wrong
 * way. Games drive every verdict figure; DLC is its own line.
 *
 * @param {Array<{id:string, name:string, platform:string, price:number|null, high:number|null, low:number|null, hours:number|null, kind?:string}>} games
 * @returns {{libraryValue:number, highestEver:number, lowestEver:number, backlogValue:number, regretScore:number|null, valuePerHour:number|null, totalHours:number, coverage:number|null, knownCount:number, unknownCount:number, dlcValue:number, dlcCount:number}}
 */
export function computeRegret(games) {
  // Add-ons are excluded from every game metric below and tallied on their own.
  const dlc = games.filter((g) => g.kind === "dlc");
  games = games.filter((g) => g.kind !== "dlc");

  const known = games.filter((g) => g.hours != null);
  const unknown = games.filter((g) => g.hours == null);

  const libraryValue = games.reduce((sum, g) => sum + (g.price || 0), 0);
  // Bounded by each game's all-time high/low; fall back to today's price when
  // ITAD has no historical figure so the band never understates the library.
  const highestEver = games.reduce((sum, g) => sum + (g.high ?? g.price ?? 0), 0);
  const lowestEver = games.reduce((sum, g) => sum + (g.low ?? g.price ?? 0), 0);
  const knownValue = known.reduce((sum, g) => sum + (g.price || 0), 0);
  const backlogValue = known
    .filter((g) => g.hours < 1)
    .reduce((sum, g) => sum + (g.price || 0), 0);

  const played = known.filter((g) => g.hours > 0);
  const playedCost = played.reduce((sum, g) => sum + (g.price || 0), 0);
  const playedHours = played.reduce((sum, g) => sum + g.hours, 0);

  // Every hour actually on record — unknown playtime counts as nothing
  // (never as zero-played), so this is the sum of the known hours.
  const totalHours = games.reduce((sum, g) => sum + (g.hours || 0), 0);

  const regretScore = knownValue ? backlogValue / knownValue : null;
  const valuePerHour = playedHours ? playedCost / playedHours : null;
  const coverage = libraryValue ? knownValue / libraryValue : null;

  // Add-on spend, kept apart from the figures above: what the DLC shelf cost
  // (re-buy basis, same as every other price here) and how many add-ons there
  // are. Null-ish sum renders as 0 when a library simply has no DLC.
  const dlcValue = dlc.reduce((sum, g) => sum + (g.price || 0), 0);

  return {
    libraryValue,
    highestEver,
    lowestEver,
    backlogValue,
    regretScore,
    valuePerHour,
    totalHours,
    coverage,
    knownCount: known.length,
    unknownCount: unknown.length,
    dlcValue,
    dlcCount: dlc.length,
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
