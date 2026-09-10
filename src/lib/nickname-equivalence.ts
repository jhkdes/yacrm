// A starter table of common English first-name nickname groups — explicitly
// non-exhaustive, append-as-you-go. Nicknames are unbounded and
// culture-specific; this covers the common cases surfaced during Phase 5
// design (Rob/Robert, Nick/Nicholas, Bill/William) plus other frequent
// English ones, not a claim of completeness.
const NICKNAME_GROUPS: string[][] = [
  ["robert", "rob", "bob", "bobby"],
  ["nicholas", "nick", "nicky"],
  ["william", "will", "bill", "billy", "liam"],
  ["michael", "mike", "mikey"],
  ["james", "jim", "jimmy"],
  ["elizabeth", "liz", "beth", "eliza", "betty"],
  ["katherine", "catherine", "kate", "katie", "kathy", "kat"],
  ["christopher", "chris"],
  ["alexander", "alexandra", "alex"],
  ["jennifer", "jen", "jenny"],
  ["richard", "rick", "dick", "richie"],
  ["daniel", "dan", "danny"],
  ["joseph", "joe", "joey"],
  ["thomas", "tom", "tommy"],
  ["charles", "charlie", "chuck"],
  ["matthew", "matt"],
  ["andrew", "andy", "drew"],
  ["david", "dave", "davey"],
  ["samuel", "sam", "sammy"],
  ["benjamin", "ben", "benny"],
  ["edward", "ed", "eddie"],
  ["margaret", "maggie", "meg", "peggy"],
  ["patricia", "pat", "patty", "trish"],
  ["susan", "sue", "susie"],
  ["deborah", "deb", "debbie"],
  ["jonathan", "jon", "jonny"],
  ["timothy", "tim", "timmy"],
  ["anthony", "tony"],
  ["gregory", "greg"],
  ["stephanie", "steph"],
  ["victoria", "vicky", "vic"],
  ["rebecca", "becky", "becca"],
  ["kenneth", "ken", "kenny"],
  ["steven", "stephen", "steve"],
  ["theodore", "ted", "theo"],
];

const GROUP_INDEX_BY_NAME = new Map<string, number>();
NICKNAME_GROUPS.forEach((group, groupIndex) => {
  for (const name of group) GROUP_INDEX_BY_NAME.set(name, groupIndex);
});

// Pure. Case-insensitive. Two names are equivalent only if both appear in
// the same known group — an unrecognized name never matches anything,
// including itself via some fallback, since that would silently widen
// matching beyond the curated list.
export function namesAreNicknameEquivalent(a: string, b: string): boolean {
  const aGroup = GROUP_INDEX_BY_NAME.get(a.toLowerCase());
  const bGroup = GROUP_INDEX_BY_NAME.get(b.toLowerCase());
  return aGroup !== undefined && aGroup === bGroup;
}
