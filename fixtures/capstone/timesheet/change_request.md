# A change: our new shop in California

Hi again, it's Marisol. Thank you for the first version: Dee and Tom already like the week page.

Big news: we are opening a second shop, in Sacramento, California, in two months. I will hire about 8 people there, and they need to use the app from the first day.

My accountant tells me California's overtime rules are different from ours, and stricter:
- overtime after 8 hours in a day, not only after 40 in a week;
- double time after 12 hours in a day;
- a special rule when someone works on all seven days of a week.

She sent me the state's page on it: https://www.dir.ca.gov/dlse/faq_overtime.htm

What I need:
- **Must:** the Sacramento people are paid under California's rules, and the Vancouver people stay exactly as they are now.
- **Must:** I say which shop a person works at when I add them.
- **Must:** the payroll file changes to the payroll company's new template, which shows the state and double time.
- **Should:** on the managers' week page, I can tell at a glance who is at which shop and who has double time.

Everything else stays the same. I've written down the answers to the questions my accountant thought you would ask.

## My answers to the questions you might ask

**Which people do the California rules apply to?**

Everyone who works at the Sacramento shop. Each person works at one shop only, and I say which when I add them. Everyone already in the app is at the Vancouver shop. If someone ever moved, I'd add them again as a new person.

**What is a workday in California?**

My accountant says our workday is midnight to midnight, bakery time. A shift that goes past midnight is split: the hours before midnight count toward the first day and the hours after toward the next. On the days the clocks change, it's still the time actually worked.

**How do daily overtime and double time work?**

In one workday, the hours up to 8 are regular, the hours over 8 up to and including 12 are overtime at one and a half times the rate, and the hours over 12 are double time, at twice the rate. Several shifts on the same day add up.

**What is the seventh-day rule?**

If someone works some time on every one of the seven days of a payroll week, Sunday to Saturday, then on the seventh day, the Saturday, their first 8 hours are overtime and anything over 8 is double time.

**Does the 40-hour weekly rule still apply in California?**

Yes. Hours over 40 in the week are overtime too, but my accountant says each hour is paid once, at the highest rate that applies. Hours already paid as daily overtime or double time don't count toward the 40: the 40 is counted from the regular hours only, and once someone has 40 regular hours in the week, any more hours that would have been regular are overtime.

**Does the pay rounding change?**

No, same rule, with double time as a third kind of pay, rounded on its own.

**What changes in the payroll file?**

The payroll company's new template adds each person's state and their double-time hours and pay (the columns are in the technical notes). Washington people have 0.00 double time. They will switch to the new template on the day we release this, and they say their old import won't read the new file.

**Does anything change for the Vancouver shop?**

No. Everything there must keep working exactly as it does now, with the 40-hours-a-week rule only.

## Technical notes: what changes in the interface

Everything in the earlier notes still holds, except as changed here.

- **People** gain `"state": "WA" | "CA"`. `POST /api/people` and `POST /api/setup` accept it and default it to `"WA"`; everyone created before this change is `"WA"`. It cannot be changed afterwards (`PATCH` with `state` is refused with `400`).
- **Timesheet totals** gain `"doubleTimeMinutes"` and `"doubleTimePayCents"`. The pay rule is unchanged, with a multiplier of 2 for double time, and `totalPayCents` is the sum of the three rounded amounts.
- **For a `"WA"` person** nothing changes: `doubleTimeMinutes` is 0.
- **For a `"CA"` person** a workday runs from 00:00 to the next 00:00, Pacific time, and a shift's minutes count toward the workday in which they were worked. The week's minutes are divided into regular, overtime and double time as the answers above describe, with each minute counted once.
- **The payroll CSV's** first line becomes exactly:

  ```
  employee_id,employee_name,state,week_start,regular_hours,overtime_hours,double_time_hours,regular_pay,overtime_pay,double_time_pay,total_pay
  ```

  with the same formats and order as before.
- **The version:** this changes the public interface, so its `version` follows Semantic Versioning 2.0.0 accordingly.
