/** Immutable, explicit country snapshots. CH is deliberately absent from EEA. */
export const COUNTRY_SETS = Object.freeze({
  'EEA@2026-01': Object.freeze('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO'.split(' ').sort()),
  'EEA+CH@2026-01': Object.freeze('AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO CH'.split(' ').sort()),
});

const isoCountries = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));

/** @param {Iterable<string>} countries */
function sorted(countries) {
  return [...new Set(countries)].sort();
}

/** @param {string[]} left @param {string[]} right */
export function sameCountries(left, right) {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

/** @param {string[]} subset @param {string[]} allowed */
export function isSubset(subset, allowed) {
  return subset.every((country) => allowed.includes(country));
}

/**
 * Reserved EEA names must reproduce their pinned snapshot. Other sets are
 * explicitly operator-supplied lists, never inferred from a regional label.
 * @param {{id: string, countries: string[]}[]} definitions
 */
export function countryRegistry(definitions) {
  const byId = new Map();
  for (const definition of definitions) {
    const duplicate = byId.has(definition.id);
    const reserved = /^(EEA|EEA\+CH)@/.test(definition.id);
    const known = COUNTRY_SETS[definition.id];
    const valid = !duplicate && definition.countries.every((country) => isoCountries.has(country))
      && (!reserved || (known && sameCountries(definition.countries, known)));
    byId.set(definition.id, valid ? definition.countries : null);
  }
  return (/** @type {string[]} */ refs) => {
    const sets = refs.map((id) => byId.get(id));
    if (sets.some((set) => !set)) return null;
    return sorted(sets.flat());
  };
}
