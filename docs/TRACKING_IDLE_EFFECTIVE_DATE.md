# Tracking reports: threshold-idle effective date

`TRACKING_THRESHOLD_IDLE_EFFECTIVE_DATE` tells the work reports (Daily, Weekly, Monthly, Employee analytics, and CSV /
Excel / PDF exports) from which day idle time is calculated with the threshold rule.

## Why it exists

Idle time used to be counted per ~10-second heartbeat tick: every tick without keyboard or mouse input added its 10
seconds to `tracking_work_session.idle_seconds`. Since the threshold-idle release, a tick is idle only when the desktop
tracker reports `is_idle` (no input for its idle threshold, 5 minutes by default). Live Tracking and the History Timeline
use the idle_start / idle_end events.

Stored counters are never rewritten. A counter is a running total with no record of when each second was added, so for a
session that ran while the new backend was deployed, the old and new seconds cannot be separated. Reports therefore label
every day:

| Day | `idle_basis` | Idle time in reports |
|---|---|---|
| Before the effective date | `legacy` | The stored counters, exactly as before |
| The effective date (deployment day) | `mixed` | **Unavailable** (`null`, shown as "Mixed calculation – unavailable"); never estimated |
| After the effective date | `threshold` | idle_start / idle_end periods of the desktop sessions that started that day (same timeline calculation as the History Timeline) |

### Sessions that span the effective date

A report attributes a whole session to its login day. A desktop session can start before the effective date and still be
running when the threshold-idle backend is deployed (for example, a tracker left running overnight keeps one session
open). Its counters then hold seconds of both rules. So a report row is also `mixed` (`idle_unavailable_reason:
"spans_effective_date"`) when its login day is before the effective date and it has a desktop session that:

* started before **00:00 Asia/Kolkata on the effective date** (the calculation boundary), and
* ended at or after that boundary, or is still open (`is_active_session`). The end is `logout_time`, otherwise the last
  heartbeat (`last_ping`); a session with neither counts as spanning.

The rule is **conservative**. The effective date is a date, not the deployment instant, so a session that ended on the
effective date before the deployment is also treated as mixed. The whole row of that employee and login day becomes
unavailable, including any other sessions of that day, because a row is one sum. Other employees and other days are not
affected, and stored counters are never changed. While the effective date is unset, nothing is reclassified.

On a mixed day, the values that are calculated from idle time are unavailable as well: desktop work time, total tracked
time, total engagement time, unaccounted time and the activity percentage. Productive time, portal time, break time and the
workday span are still shown. Weekly, monthly and analytics totals that include a mixed day are `null`. The sum of the
other days is returned next to them (`total_idle_time_known_days`, `total_tracked_time_known_days`), together with the
unavailable dates (`idle_unavailable_dates`). A genuine zero idle is always `"00:00:00"`, never `null`.

Exports show "Mixed calculation – unavailable" (PDF: "Unavailable †" with a legend under the table). CSV exports start
with a UTF-8 byte order mark (`EF BB BF`), so Excel shows the label and non-ASCII names (for example Malayalam) correctly.
XLSX and PDF files have no BOM.

## Configuration

* Format: `YYYY-MM-DD`, the **Asia/Kolkata calendar date** of the production deployment of the threshold-idle backend.
* Unset or empty: every day is `legacy`, so the report calculation is unchanged. This is the default until the
  deployment date is confirmed.
* Invalid values (not exactly `YYYY-MM-DD`, or not a real date) are rejected. The reports then use `legacy` for every day,
  and the backend logs an error naming the variable.
* The value is read when a report is requested. A change takes effect after the backend process is restarted with the new
  environment.

## How to set it during the production deployment

1. Deploy the threshold-idle backend.
2. Note the **Asia/Kolkata date** on which the new backend started serving heartbeats. For example, a deployment at
   01:15 IST on 21 Nov 2026 is `2026-11-21`, even though it is still 20 Nov in UTC.
3. Add this line to the backend's production environment, using the date from step 2:

   ```
   TRACKING_THRESHOLD_IDLE_EFFECTIVE_DATE=2026-11-21
   ```

   The date above is only an example. Never guess the date, and never set it before the deployment has happened.
4. Restart the backend.
5. Check the Daily report for the deployment day. It should show "Mixed calculation – unavailable" for idle time. The day
   before should show the stored values, and later days should show threshold idle.

Never move the date afterwards to "fix" numbers. If the deployment is rolled back and redeployed, use the date of the
deployment that stayed in production. Any day on which old-rule and new-rule heartbeats were both recorded is a mixed day.
