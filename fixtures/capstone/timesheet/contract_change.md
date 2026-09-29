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
