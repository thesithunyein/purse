import { test } from "node:test";
import assert from "node:assert/strict";
import { BudgetExhausted, Ledger } from "../src/ledger.js";

const fresh = () => new Ledger([{ id: "alice", label: "Alice", apiKey: "k", bondUsd: 0.2 }]);

test("debit lowers what remains and ignores negative or NaN costs", () => {
  const ledger = fresh();
  assert.equal(ledger.debit("alice", 0.05), 0.15000000000000002);
  ledger.debit("alice", -1);
  ledger.debit("alice", Number.NaN);
  assert.equal(ledger.get("alice").spentUsd, 0.05);
});

test("requireReserve refuses a call the bond cannot cover", () => {
  const ledger = fresh();
  ledger.debit("alice", 0.18);
  assert.throws(() => ledger.requireReserve("alice", 0.03), BudgetExhausted);
  assert.doesNotThrow(() => ledger.requireReserve("alice", 0.001));
});

test("slash never takes more than the bond holds and reports what it took", () => {
  const ledger = fresh();
  ledger.debit("alice", 0.05);
  assert.equal(ledger.slash("alice", 12), 0.15000000000000002);
  assert.equal(ledger.remaining("alice"), 0);
  assert.equal(ledger.get("alice").slashes, 1);
  assert.equal(ledger.slash("alice", 1), 0);
});

test("setBond starts a fresh meter and reset clears spend and slashes", () => {
  const ledger = fresh();
  ledger.slash("alice", 1);
  ledger.setBond("alice", 0.5);
  assert.equal(ledger.remaining("alice"), 0.5);
  ledger.debit("alice", 0.1);
  ledger.reset();
  assert.equal(ledger.remaining("alice"), 0.5);
  assert.equal(ledger.get("alice").slashes, 0);
});

test("unknown accounts throw", () => {
  assert.throws(() => fresh().get("mallory"), /unknown account/);
});
