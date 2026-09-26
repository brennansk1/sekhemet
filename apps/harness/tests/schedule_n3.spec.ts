import type { CardRecord } from "@sekhemet/kernel";
import { describe, expect, it } from "vitest";
import { unattendedStartRefusal } from "../src/reservation.js";
import { batchBySwaps } from "../src/wave2.js";

// NEW-models-3: reserved hours and swap batching by project. Nothing loads.

const card = (id: string, projectId: string, more: Partial<CardRecord> = {}): CardRecord =>
  ({
    id,
    title: id,
    status: "ready",
    projectId,
    scopeFiles: [],
    stepBudget: 10,
    stepsUsed: 0,
    createdAt: "",
    updatedAt: "",
    ...more,
  }) as unknown as CardRecord;

describe("NEW-models-3", () => {
  it("MD-N3-2: runs each project's cards together before the next project", () => {
    const order = batchBySwaps([
      card("a1", "alpha"),
      card("b1", "beta"),
      card("a2", "alpha"),
      card("b2", "beta"),
    ]).map((c) => c.id);
    expect(order).toEqual(["a1", "a2", "b1", "b2"]);
  });

  it("MD-N3-2: unless a dependency forces the order", () => {
    const order = batchBySwaps([
      card("a1", "alpha"),
      card("a2", "alpha", { dependsOn: ["b1"] }),
      card("b1", "beta"),
      card("b2", "beta"),
    ]).map((c) => c.id);
    expect(order.indexOf("b1")).toBeLessThan(order.indexOf("a2"));
    expect(order).toEqual(["a1", "b1", "a2", "b2"]);
  });

  it("MD-N3-1: a reserved machine starts no backlog card unattended, unless it is urgent", () => {
    const routine = card("r", "alpha", { priority: 3 });
    const urgent = card("u", "alpha", { priority: 1 });
    const reserved = { unattended: true, reservedNow: true, inReservedHours: false };
    expect(unattendedStartRefusal(routine, reserved)).toMatch(/reserved.*not urgent/);
    expect(unattendedStartRefusal(urgent, reserved)).toBeUndefined();
    const hours = { unattended: true, reservedNow: false, inReservedHours: true };
    expect(unattendedStartRefusal(routine, hours)).toMatch(/reserved hours/);
    // A person at the machine starts what they like; a free machine runs the backlog.
    expect(unattendedStartRefusal(routine, { ...reserved, unattended: false })).toBeUndefined();
    expect(
      unattendedStartRefusal(routine, {
        unattended: true,
        reservedNow: false,
        inReservedHours: false,
      }),
    ).toBeUndefined();
  });
});
