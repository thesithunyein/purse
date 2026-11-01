export class BudgetExhausted extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetExhausted";
  }
}

export type Account = {
  id: string;
  label: string;
  apiKey: string;
  bondUsd: number;
  spentUsd: number;
  slashes: number;
};

export class Ledger {
  private accounts = new Map<string, Account>();

  constructor(seed: Array<{ id: string; label: string; apiKey: string; bondUsd: number }>) {
    for (const entry of seed) {
      this.accounts.set(entry.id, {
        id: entry.id,
        label: entry.label,
        apiKey: entry.apiKey,
        bondUsd: entry.bondUsd,
        spentUsd: 0,
        slashes: 0,
      });
    }
  }

  get(id: string): Account {
    const account = this.accounts.get(id);
    if (!account) throw new Error(`unknown account ${id}`);
    return account;
  }

  list(): Account[] {
    return [...this.accounts.values()];
  }

  remaining(id: string): number {
    const account = this.get(id);
    return Math.max(0, account.bondUsd - account.spentUsd);
  }

  // Called before every model call. If the bond cannot cover a single call the
  // run stops here rather than discovering the problem from an invoice.
  requireReserve(id: string, reserveUsd: number): void {
    const remaining = this.remaining(id);
    if (remaining < reserveUsd) {
      throw new BudgetExhausted(
        `bond has $${remaining.toFixed(6)} left, a call reserve is $${reserveUsd.toFixed(6)}`,
      );
    }
  }

  debit(id: string, costUsd: number): number {
    const account = this.get(id);
    account.spentUsd += costUsd;
    return Math.max(0, account.bondUsd - account.spentUsd);
  }

  slash(id: string, penaltyUsd: number): void {
    const account = this.get(id);
    const remaining = Math.max(0, account.bondUsd - account.spentUsd);
    const taken = Math.min(remaining, Math.max(0, penaltyUsd));
    account.spentUsd += taken;
    account.slashes += 1;
  }

  setBond(id: string, bondUsd: number): void {
    const account = this.get(id);
    account.bondUsd = Math.max(0, bondUsd);
    account.spentUsd = 0;
  }

  reset(): void {
    for (const account of this.accounts.values()) {
      account.spentUsd = 0;
      account.slashes = 0;
    }
  }
}
