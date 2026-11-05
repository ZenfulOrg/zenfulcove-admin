// Pure-function checks for lib/meta-audiences.js (no network).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const src = await import("node:fs").then((fs) => fs.readFileSync(new URL("../lib/meta-audiences.js", import.meta.url), "utf8"));
const pure = src.replace(/^import .*@\/lib.*$/gm, "");
const mod = await import("data:text/javascript," + encodeURIComponent(pure));
const h = (v) => createHash("sha256").update(v).digest("hex");
assert.equal(mod.metaEmail("  Jane.Doe@Gmail.COM "), "jane.doe@gmail.com");
assert.equal(mod.metaEmail("not-an-email"), "");
assert.equal(mod.metaPhone("(281) 797-5622"), "12817975622");
assert.equal(mod.metaPhone("+1 281-797-5622"), "12817975622");
assert.equal(mod.metaPhone("1111111111"), "");
assert.equal(mod.metaName(" Mary-Jane "), "maryjane");
const rows = mod.metaAudienceRows([
  { email: "A@b.com", phone: "2817975622", firstName: "Ann", lastName: "O'Neil" },
  { email: "a@b.com", phone: "", firstName: "", lastName: "" },
  { email: "", phone: "", firstName: "x" },
]);
assert.equal(rows.length, 1);
assert.equal(rows[0].email, h("a@b.com"));
assert.equal(rows[0].phone, h("12817975622"));
assert.equal(rows[0].ln, h("oneil"));
assert.equal(rows[0].country, h("us"));
const csv = mod.metaAudienceCsv(rows);
assert.equal(csv.split("\n")[0], "email,phone,fn,ln,country");
assert.ok(!/a@b\.com|2817975622/.test(csv), "csv must contain no plain identifiers");
const sel = mod.selectAudience("past-guests", {
  emailContacts: [{ email: "p@x.com" }, { email: "s@x.com" }], smsContacts: [], pastGuestEmails: new Set(["p@x.com"]),
});
assert.deepEqual(sel.map((c) => c.email), ["p@x.com"]);
assert.equal(mod.selectAudience("subscribers", { emailContacts: [{ email: "p@x.com" }, { email: "s@x.com" }], smsContacts: [], pastGuestEmails: new Set(["p@x.com"]) })[0].email, "s@x.com");
console.log("meta audience tests passed");
