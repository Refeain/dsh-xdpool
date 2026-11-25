import { describe, expect, it } from 'vitest'
import { dayKeyOf, earnedNothing, earnedToday } from '../src/client/earned-today.ts'
import type { EarnedEntry, EarnedStatus } from '../src/client/earned-today.ts'

/**
 * "How much did the automation get today" -- the number the panel shows.
 *
 * Two sources feed it and they are easy to confuse, which is exactly what
 * happened on the first attempt: the ledger alone said "nothing earned" on a day
 * when all four accounts had already collected 100 credits each, because the
 * automation had not run yet and the ledger only records what the automation
 * itself collected. These cases pin down which source answers which part.
 */
const TODAY = '2026-11-25'

function entry(date: string, over: Partial<EarnedEntry> = {}): EarnedEntry {
  return {
    credit: 0,
    energy: 0,
    claimed: 0,
    checkinCredit: 0,
    bonusCredit: 0,
    travelCredit: 0,
    compensationCredit: 0,
    date,
    ...over,
  }
}

function status(over: Partial<EarnedStatus> = {}): EarnedStatus {
  return { accounts: [], ...over }
}

describe('check-in credits', () => {
  it('counts credits the accounts already collected, with no ledger at all', () => {
    // The case that made the first version wrong: the credits are real, they
    // were just collected somewhere other than this automation's own pass.
    const s = status({
      accounts: [
        { checkin: { todayCredit: 100 } },
        { checkin: { todayCredit: 100 } },
        { checkin: { todayCredit: 100 } },
        { checkin: { todayCredit: 100 } },
      ],
    })
    expect(earnedToday(s, TODAY).credit).toBe(400)
  })

  it('does not double-count a check-in the automation itself collected', () => {
    // Same 100 credits appear twice in the document -- once on the account row,
    // once in the ledger's `checkinCredit` column. Adding both would report 200.
    const s = status({
      accounts: [{ checkin: { todayCredit: 100 } }],
      automation: { earningsToday: { a: entry(TODAY, { checkinCredit: 100 }) } },
    })
    expect(earnedToday(s, TODAY).credit).toBe(100)
  })

  it('treats a missing check-in probe as zero, not as an error', () => {
    // `checkin` is absent whenever the per-account probe failed or the activity
    // is paused; the rest of the totals must still be reported.
    const s = status({
      accounts: [{}, { checkin: { todayCredit: 50 } }],
      automation: { earningsToday: { a: entry(TODAY, { travelCredit: 10 }) } },
    })
    expect(earnedToday(s, TODAY).credit).toBe(60)
  })
})

describe('the other passes', () => {
  it('sums every ledger column except check-in', () => {
    const s = status({
      automation: {
        earningsToday: {
          a: entry(TODAY, {
            credit: 30,
            energy: 7,
            claimed: 2,
            bonusCredit: 20,
            travelCredit: 10,
            compensationCredit: 500,
          }),
        },
      },
    })
    expect(earnedToday(s, TODAY)).toEqual({ credit: 560, energy: 7, claimed: 2 })
  })

  it('skips a ledger row dated before today', () => {
    // A settings document written by an older build can still hold these.
    // Summing them reported last week's credits as today's: 640 shown against
    // the 400 the accounts had actually earned.
    const s = status({
      accounts: [{ checkin: { todayCredit: 400 } }],
      automation: {
        earningsToday: {
          old: entry('2026-11-23', { checkinCredit: 200, travelCredit: 16, credit: 100 }),
        },
      },
    })
    expect(earnedToday(s, TODAY).credit).toBe(400)
  })

  it('mixes a fresh row with a stale one without leaking the stale values', () => {
    const s = status({
      automation: {
        earningsToday: {
          old: entry('2026-10-25', { travelCredit: 6, energy: 4 }),
          fresh: entry(TODAY, { travelCredit: 10, energy: 1 }),
        },
      },
    })
    expect(earnedToday(s, TODAY)).toEqual({ credit: 10, energy: 1, claimed: 0 })
  })
})

describe('nothing to report', () => {
  it('is all zeroes when there is no document at all', () => {
    expect(earnedNothing(earnedToday(undefined, TODAY))).toBe(true)
  })

  it('is all zeroes when the ledger is empty and no account has claimed', () => {
    expect(earnedNothing(earnedToday(status({ accounts: [{}] }), TODAY))).toBe(true)
  })

  it('is not "nothing" when only a task count came in', () => {
    // Credits of zero with a claimed task is still something that happened, and
    // the row must appear: a task was checked off.
    const s = status({ automation: { earningsToday: { a: entry(TODAY, { claimed: 1 }) } } })
    expect(earnedNothing(earnedToday(s, TODAY))).toBe(false)
  })
})

describe('the day key', () => {
  it('pads month and day, matching the keys the scheduler writes', () => {
    expect(dayKeyOf(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })

  it('uses the local calendar, not UTC', () => {
    // Late evening locally is already tomorrow in UTC; the scheduler keys on
    // the local day, so a UTC-based key would file the evening's credits under
    // the wrong date for anyone east of Greenwich.
    const lateEvening = new Date(2026, 10, 25, 23, 30)
    expect(dayKeyOf(lateEvening)).toBe('2026-11-25')
  })
})
