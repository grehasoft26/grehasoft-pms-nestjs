# Active Time (Live Tracking, History Timeline, desktop Today's Work)

One calculation, three screens:

| Screen | Field |
|---|---|
| Admin → Tracking → History Timeline, "Active time" card | `GET /tracking/reports/timeline` → `summary.active_seconds` |
| Admin → Tracking → Live Tracking, "Active Time" column | `GET /tracking/employee-status` → `active_seconds_today` / `active_time` |
| Desktop tracker, "Today's Work" | `GET /tracking/employee-status/{id}` → `active_seconds_today` (+ local extrapolation, max 90 s) |

The calculation is `buildTrackingTimeline` (`src/modules/tracking/tracking-timeline.ts`). Live Tracking reuses the timeline that
`loadLiveIdleBatch` already builds for idle time: no extra queries.

## Definition

For one employee and one Asia/Kolkata reporting day:

```
Active Time = | ∪ desktop session spans ∩ day |  −  | (∪ idle, locked, sleep periods  ∪  completed manual breaks) ∩ spans |
```

- Session span: ended = start → end; running = start → now (while the last heartbeat is under 5 minutes old);
  otherwise start → last heartbeat (never later).
- Idle starts at last input + 120 s (the tracker's company threshold), so those 2 minutes count as active.
- Offline periods are **not** subtracted: while the tracker runs offline it keeps measuring, and its queued idle, lock and
  sleep events still mark inactivity once they are synced. Time without a running tracker session is outside every span.
  A late offline batch extends the session it belongs to; spans are merged, so a resent batch never adds time twice.
- Overlapping periods are merged before subtracting (nothing is subtracted twice).

## Incomplete data (`active_estimated: true`)

The value is always a number. When a start or end is unknown it is closed conservatively and the result is marked
`active_estimated: true` (History shows an "Estimated" badge, Live an "Est." badge):

- session without a recorded end → counted to its last heartbeat;
- idle / lock / sleep without an end → inactive until its session's last known boundary;
- idle / lock / sleep end without a start → inactive since the previous recorded event of that session (or the session start);
- truncated data (row caps reached).

An unfinished offline period or manual break does not make the value an estimate (neither is subtracted from session time).

## Employee status fields

| Field | Meaning |
|---|---|
| `active_seconds_today` | Active Time in seconds (= History's `summary.active_seconds` for the same employee and day) |
| `active_time` | the same as HH:MM:SS |
| `active_basis` | `timeline`, or `heartbeat_counters` when events cannot be read (labelled fallback, always estimated) |
| `active_estimated` | see above |
| `as_of` | when the values were calculated (UTC ISO) |
| `report_date`, `report_time_zone` | the reporting day (Asia/Kolkata) |

`productive_time` (heartbeat counters) is unchanged, for older trackers and the Reports, which still use it.
