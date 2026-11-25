/**
 * "What did the automation get today", as one number set.
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * The panel could already say how many ACCOUNTS claimed ("Claimed today 4/6")
 * but never how many CREDITS those claims were worth, which is the number a
 * person actually budgets with. Answering it means adding up two sources that
 * are not interchangeable:
 *
 *   - check-in credits, which exist whether or not this automation collected
 *     them (a hand check-in in the desktop app pays too), so they come from the
 *     live upstream status carried on each account row;
 *   - every other pass (task centre, streak bonus, buddy travel, outage
 *     compensation), which only the automation can collect, so they come from
 *     its own ledger.
 *
 * Reading only the ledger was the first attempt and it reported "nothing
 * earned" on a day when all four accounts had collected 100 credits each: the
 * ledger is empty until the automation's own first pass runs. Reading check-in
 * from the ledger as well would double-count the days it did run. Keeping the
 * split here -- as a pure function over a plain status document -- is what makes
 * both mistakes testable without a browser.
 *
 * @module dsh-xdpool/client/earned-today
 */

/** One account's ledger row, as the scheduler persists it. */
export interface EarnedEntry {
  credit: number
  energy: number
  claimed: number
  checkinCredit: number
  bonusCredit: number
  travelCredit: number
  compensationCredit: number
  /** Local date the counters belong to. */
  date: string
}

/** The parts of one account row this module reads. */
export interface EarnedAccount {
  checkin?: { todayCredit: number } | undefined
}

/** The parts of a status document this module reads. */
export interface EarnedStatus {
  accounts: readonly EarnedAccount[]
  automation?: {
    earningsToday?: Readonly<Record<string, EarnedEntry>> | undefined
  } | undefined
}

/** What came in today. All zeroes means "nothing yet", which callers hide. */
export interface EarnedTotals {
  credit: number
  energy: number
  claimed: number
}

/** Local calendar day, matching the `YYYY-MM-DD` keys the scheduler writes. */
export function dayKeyOf(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${String(date.getFullYear())}-${month}-${day}`
}

/**
 * Add up today's take.
 *
 * `today` is passed in rather than read from the clock so the caller can decide
 * what "today" means (and so the test does not depend on when it runs).
 *
 * Ledger rows dated before `today` are skipped. The scheduler now drops them on
 * restore, but a settings document written by an older build is still on disk,
 * and summing those would report last week's credits as today's.
 */
export function earnedToday(status: EarnedStatus | undefined, today: string): EarnedTotals {
  const totals: EarnedTotals = { credit: 0, energy: 0, claimed: 0 }
  if (status === undefined) return totals
  // Check-in first: it is the one credit source that exists independently of
  // whether the automation ran.
  for (const account of status.accounts) {
    totals.credit += account.checkin?.todayCredit ?? 0
  }
  for (const entry of Object.values(status.automation?.earningsToday ?? {})) {
    if (entry.date !== today) continue
    // `checkinCredit` is deliberately absent: the loop above already counted
    // those credits from the account rows, and adding both would double every
    // check-in the automation itself collected.
    totals.credit += entry.credit + entry.bonusCredit + entry.travelCredit + entry.compensationCredit
    totals.energy += entry.energy
    totals.claimed += entry.claimed
  }
  return totals
}

/** True when there is nothing to report, which callers turn into an absent row. */
export function earnedNothing(totals: EarnedTotals): boolean {
  return totals.credit === 0 && totals.energy === 0 && totals.claimed === 0
}
