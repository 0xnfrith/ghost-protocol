// The golden recipe (golden/recipe.mjs): it applies exactly, and a miss is loud.
import test from "node:test";
import assert from "node:assert/strict";
import { FILES, MESSAGES, RENAMES, applyRecipe } from "./golden/recipe.mjs";

// A text that holds every old text of the table once, and every renamed word.
const sample = () => {
  const texts = Object.fromEntries(FILES.map((f) => [f, ""]));
  for (const m of MESSAGES) texts[m.file] += `${m.from}\n`;
  for (const r of RENAMES) texts[FILES[0]] += `x ${r.from} y\n${r.from}_suffix move-to-${r.from}\n`;
  return texts;
};

test("every message is replaced once and every renamed word is renamed, whole words only", () => {
  const out = applyRecipe(sample());
  // (a new text may itself hold a renamed word, which the renames then rename)
  const renamed = (text) => RENAMES.reduce((t, r) => t.replace(new RegExp(`(?<![\\w-])${r.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w])`, "g"), r.to), text);
  for (const m of MESSAGES) assert.ok(out[m.file].includes(renamed(m.to)), m.to);
  for (const r of RENAMES) {
    assert.ok(out[FILES[0]].includes(`x ${r.to} y\n`), r.from);
    assert.ok(out[FILES[0]].includes(`${r.from}_suffix`), `${r.from}_suffix is not the word`);
    assert.ok(out[FILES[0]].includes(`move-to-${r.from}`), `a hyphenated name is not the word`);
  }
});

test("a message that is not in the original, or is in it twice, fails the recipe", () => {
  const s = sample();
  s[MESSAGES[0].file] = s[MESSAGES[0].file].replace(MESSAGES[0].from, "");
  assert.throws(() => applyRecipe(s), /0 times, not 1/);
  const t = sample();
  t[MESSAGES[0].file] += MESSAGES[0].from;
  assert.throws(() => applyRecipe(t), /2 times, not 1/);
});

test("a renamed word that is in none of the files fails the recipe", () => {
  const s = sample();
  s[FILES[0]] = s[FILES[0]].replaceAll(RENAMES[0].from, "zzz");
  assert.throws(() => applyRecipe(s), /is in none of the files/);
});
